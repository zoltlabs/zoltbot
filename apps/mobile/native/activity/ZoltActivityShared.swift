import ActivityKit
import Foundation

/// P3: the Live Activity's data. Pushes from the relay carry only `ContentState` (two counts and
/// the top request's id); the request's title and chat live in the App Group cache the app writes.
@available(iOS 16.1, *)
struct ZoltActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    var working: Int
    var needsYou: Int
    /// The request the Mac counts as top. The cached title shows only while it matches, so a
    /// push never leaves an old title under new counts.
    var topId: String?
  }
  /// The Mac this activity is about, set by the app when it starts.
  var macName: String
}

/// The top request, kept on the phone. Never sent through a push.
struct ZoltActivityTop: Codable, Equatable {
  let interactionId: String
  let threadId: String
  let title: String
}

enum ZoltActivityCache {
  private static func url() -> URL? {
    let key = "ZoltActivityAppGroup"
    guard let group = Bundle.main.object(forInfoDictionaryKey: key) as? String,
      let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return root.appendingPathComponent("ZoltActivity-top.json")
  }
  static func write(_ top: ZoltActivityTop?) {
    guard let url = url() else { return }
    guard let top, let data = try? JSONEncoder().encode(top) else {
      try? FileManager.default.removeItem(at: url)
      return
    }
    // Readable while the phone is locked, since the Lock Screen shows it.
    try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  static func read() -> ZoltActivityTop? {
    guard let url = url(), let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(ZoltActivityTop.self, from: data)
  }
}

@available(iOS 16.1, *)
extension ZoltActivityAttributes.ContentState {
  /// The cached request, when it is the one these counts are about.
  func top(_ cached: ZoltActivityTop?) -> ZoltActivityTop? {
    guard needsYou > 0, let cached, let topId, cached.interactionId == topId else { return nil }
    return cached
  }
}

enum ZoltActivityLinks {
  private static let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._:"))
  /// Opens the chat the request is in; the app shows the request there.
  static func chat(_ top: ZoltActivityTop?) -> URL {
    guard let top, let id = top.threadId.addingPercentEncoding(withAllowedCharacters: safe),
      !id.isEmpty, let url = URL(string: "zoltbot://chat/\(id)")
    else { return URL(string: "zoltbot://")! }
    return url
  }
}
