import Foundation
import Intents
import UIKit

struct ShareRecipient: Codable, Equatable {
  let id: String
  let macId: String
  let threadId: String
  let name: String
}
struct SharePhoto: Codable {
  let base64: String
  let mimeType: String
}
struct SharedDraft: Codable {
  let version: Int
  let id: String
  let createdAt: String
  let macId: String
  var recipientId: String
  var text: String
  let images: [SharePhoto]
  var sentThreadId: String? = nil
}

enum ShareStore {
  static func root() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ZoltShareAppGroup") as? String,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw failure("Sharing is not configured. Rebuild with the App Group enabled.") }
    let url = root.appendingPathComponent("ZoltShare", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
  static func failure(_ message: String) -> NSError {
    NSError(domain: "ZoltShare", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
  static func write<T: Encodable>(_ value: T, to url: URL) throws {
    try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtection])
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    var file = url
    try file.setResourceValues(resource)
  }
  static func recipients() throws -> [ShareRecipient] {
    let file = try root().appendingPathComponent("recipients.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    return try JSONDecoder().decode([ShareRecipient].self, from: Data(contentsOf: file))
  }
  static func draftURL(_ id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw failure("Invalid shared draft.") }
    return try root().appendingPathComponent("draft-\(id).json")
  }
  static func draft(_ id: String) throws -> SharedDraft {
    let draft = try JSONDecoder().decode(SharedDraft.self, from: Data(contentsOf: draftURL(id)))
    guard draft.version == 1, draft.id == id else { throw failure("Unsupported shared draft.") }
    return draft
  }
  static func drafts() throws -> [SharedDraft] {
    try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil)
      .filter { $0.lastPathComponent.hasPrefix("draft-") && $0.pathExtension == "json" }
      .map { try JSONDecoder().decode(SharedDraft.self, from: Data(contentsOf: $0)) }
      .sorted { $0.createdAt < $1.createdAt }
  }
  static func save(_ draft: SharedDraft, isNew: Bool = false) throws {
    guard draft.version == 1, draft.text.utf8.count <= 16_000,
      draft.images.count <= 5,
      draft.images.allSatisfy({ $0.mimeType == "image/jpeg" && $0.base64.count <= 80_000 })
    else { throw failure("This share is too large. Use up to five photos and a shorter message.") }
    if isNew, try drafts().count >= 50 {
      throw failure("Your shared drafts inbox is full. Send or discard drafts in Zoltbot first.")
    }
    try write(draft, to: draftURL(draft.id))
  }
  static func sync(_ next: [ShareRecipient]) throws {
    let old = try recipients()
    try write(next, to: root().appendingPathComponent("recipients.json"))
    let removed = old.filter { previous in !next.contains(where: { $0.id == previous.id }) }.map(\.id)
    for id in removed { INInteraction.delete(with: id, completion: nil) }
  }
  static func avatar(_ recipient: ShareRecipient) -> UIImage {
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 96))
    return renderer.image { context in
      let hash = recipient.id.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
      UIColor(hue: CGFloat(hash % 360) / 360, saturation: 0.55, brightness: 0.65, alpha: 1).setFill()
      context.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: 96, height: 96))
      let initial = String(recipient.name.prefix(1)).uppercased() as NSString
      let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 44), .foregroundColor: UIColor.white]
      let size = initial.size(withAttributes: attrs)
      initial.draw(at: CGPoint(x: (96 - size.width) / 2, y: (96 - size.height) / 2), withAttributes: attrs)
    }
  }
  static func donate(_ recipient: ShareRecipient, completion: @escaping (Error?) -> Void) {
    let image = avatar(recipient).pngData().map { INImage(imageData: $0) }
    let person = INPerson(
      personHandle: INPersonHandle(value: recipient.id, type: .unknown),
      nameComponents: nil, displayName: recipient.name, image: image,
      contactIdentifier: nil, customIdentifier: recipient.id
    )
    let intent = INSendMessageIntent(
      recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil,
      speakableGroupName: nil, conversationIdentifier: recipient.id,
      serviceName: nil, sender: nil, attachments: nil
    )
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.identifier = UUID().uuidString
    interaction.groupIdentifier = recipient.id
    interaction.direction = .outgoing
    interaction.donate(completion: completion)
  }
}
