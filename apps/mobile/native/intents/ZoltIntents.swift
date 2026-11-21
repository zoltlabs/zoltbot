import ActivityKit
import AppIntents
import Foundation
import ImageIO
import UIKit

// P4: Siri and Shortcuts actions. Asking or sending writes a draft into the share store, the same
// place the share sheet puts one, and opens it in the app for the owner to send. Nothing is sent
// from Siri on its own. "What needs me?" answers from the Live Activity, without opening the app.

@available(iOS 16.0, *)
struct AgentEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
  static let defaultQuery = AgentQuery()
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
  init(_ recipient: ShareRecipient) {
    id = recipient.id
    name = recipient.name
  }
}

/// The agents the app last listed for the shown Mac.
@available(iOS 16.0, *)
struct AgentQuery: EntityStringQuery {
  private func all() throws -> [AgentEntity] {
    do { return try ShareStore.recipients().map(AgentEntity.init) }
    // The directory is readable only while the iPhone is unlocked.
    catch CocoaError.fileReadNoPermission { throw ZoltDrafts.locked }
  }
  func entities(for identifiers: [String]) async throws -> [AgentEntity] {
    try all().filter { identifiers.contains($0.id) }
  }
  func entities(matching string: String) async throws -> [AgentEntity] {
    try all().filter { $0.name.localizedCaseInsensitiveContains(string) }
  }
  func suggestedEntities() async throws -> [AgentEntity] {
    try all()
  }
}

enum ZoltDrafts {
  static let locked = ShareStore.failure("Unlock your iPhone first.")
  private static let maxAge: TimeInterval = 120

  /// The draft the app should open next. A cold launch drops the URL below before React Native
  /// listens, so the app also takes this on start and on each return.
  private static func pendingURL() throws -> URL { try ShareStore.root().appendingPathComponent("open-draft.json") }
  private struct Pending: Codable { let id: String; let at: Date }

  static func takePending() -> String? {
    guard let url = try? pendingURL(), let data = try? Data(contentsOf: url) else { return nil }
    try? FileManager.default.removeItem(at: url)
    guard let pending = try? JSONDecoder().decode(Pending.self, from: data),
      abs(pending.at.timeIntervalSinceNow) < maxAge, UUID(uuidString: pending.id) != nil
    else { return nil }
    return pending.id
  }

  /// Saves a draft for the agent and opens it in the app, where the owner sends it.
  static func open(agentId: String, text: String, photos: [Data]) async throws {
    guard let recipient = try ShareStore.recipients().first(where: { $0.id == agentId }) else {
      throw ShareStore.failure("This agent is no longer available. Open Zoltbot and try again.")
    }
    guard photos.count <= 5 else { throw ShareStore.failure("Use up to five photos.") }
    guard text.utf8.count <= 16_000 else { throw ShareStore.failure("That message is too long. Shorten it and try again.") }
    let images = try photos.map { data -> SharePhoto in
      guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
      else { throw ShareStore.failure("Could not decode this photo.") }
      return try ShareStore.photo(source)
    }
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else {
      throw ShareStore.failure("Add a message or photo first.")
    }
    let draft = SharedDraft(
      version: 1, id: UUID().uuidString, createdAt: ISO8601DateFormatter().string(from: Date()),
      macId: recipient.macId, recipientId: recipient.id, text: text, images: images)
    try ShareStore.save(draft, isNew: true)
    try ShareStore.write(Pending(id: draft.id, at: Date()), to: pendingURL())
    guard let url = URL(string: "zoltbot://shared/\(draft.id)") else { return }
    await MainActor.run { UIApplication.shared.open(url) }
  }
}

@available(iOS 16.0, *)
struct AskAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Ask agent"
  static let description = IntentDescription("Write a question to one of your agents, then send it from Zoltbot.")
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Agent", requestValueDialog: "Which agent?")
  var agent: AgentEntity
  @Parameter(title: "Question", requestValueDialog: "What do you want to ask?")
  var question: String

  static var parameterSummary: some ParameterSummary { Summary("Ask \(\.$agent) \(\.$question)") }

  func perform() async throws -> some IntentResult {
    try await ZoltDrafts.open(agentId: agent.id, text: question, photos: [])
    return .result()
  }
}

@available(iOS 16.0, *)
struct SendToAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Send to agent"
  static let description = IntentDescription("Give one of your agents a message or photos, then send it from Zoltbot.")
  static let openAppWhenRun = true
  static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

  @Parameter(title: "Agent", requestValueDialog: "Which agent?")
  var agent: AgentEntity
  @Parameter(title: "Message", requestValueDialog: "What should I send?")
  var message: String?
  @Parameter(title: "Photos", supportedTypeIdentifiers: ["public.image"])
  var photos: [IntentFile]?

  static var parameterSummary: some ParameterSummary {
    Summary("Send \(\.$message) to \(\.$agent)") { \.$photos }
  }

  func perform() async throws -> some IntentResult {
    let files = photos ?? []
    // By voice there are no photos, and Siri doesn't ask for an optional message on its own.
    if files.isEmpty, (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      throw $message.needsValueError("What should I send?")
    }
    try await ZoltDrafts.open(agentId: agent.id, text: message ?? "", photos: files.map(\.data))
    return .result()
  }
}

@available(iOS 16.0, *)
struct WhatNeedsMeIntent: AppIntent {
  static let title: LocalizedStringResource = "What needs me?"
  static let description = IntentDescription("Hear how many agents are working and what is waiting on you.")

  func perform() async throws -> some IntentResult & ProvidesDialog {
    .result(dialog: IntentDialog(stringLiteral: Self.answer()))
  }

  static func answer() -> String {
    guard #available(iOS 16.2, *),
      let activity = Activity<ZoltActivityAttributes>.activities.first(where: { $0.activityState == .active })
    else {
      return "Open Zoltbot to see what needs you."
    }
    let state = activity.content.state
    return ZoltNeedsMe.sentence(
      mac: activity.attributes.macName, working: state.working, needsYou: state.needsYou,
      title: state.top(ZoltActivityCache.read())?.title)
  }
}

enum ZoltNeedsMe {
  static func sentence(mac: String, working: Int, needsYou: Int, title: String?) -> String {
    let agents = working == 1 ? "1 agent is working" : "\(working) agents are working"
    let place = mac.isEmpty ? "" : "On \(mac): "
    guard needsYou > 0 else { return "\(place)\(agents). Nothing needs you." }
    let waiting = needsYou == 1 ? "1 request needs you" : "\(needsYou) requests need you"
    guard let title, !title.isEmpty else { return "\(place)\(agents). \(waiting)." }
    return "\(place)\(agents). \(waiting), starting with “\(title)”."
  }
}

@available(iOS 16.0, *)
struct ZoltShortcutsProvider: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskAgentIntent(),
      phrases: ["Ask \(\.$agent) in \(.applicationName)", "Ask \(.applicationName)"])
    AppShortcut(
      intent: SendToAgentIntent(),
      phrases: ["Send to \(\.$agent) in \(.applicationName)", "Send to \(.applicationName)"])
    AppShortcut(
      intent: WhatNeedsMeIntent(),
      phrases: ["What needs me in \(.applicationName)", "What's waiting in \(.applicationName)"])
  }
}
