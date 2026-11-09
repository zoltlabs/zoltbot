import Foundation
import React

@objc(ZoltShare)
final class ZoltShare: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  private func perform(_ resolve: RCTPromiseResolveBlock, _ reject: RCTPromiseRejectBlock, _ body: () throws -> Any?) {
    do { resolve(try body()) }
    catch { reject("ZOLT_SHARE", error.localizedDescription, error) }
  }
  @objc func syncRecipients(_ values: [[String: String]], resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let recipients = try JSONDecoder().decode([ShareRecipient].self, from: JSONSerialization.data(withJSONObject: values))
      try ShareStore.sync(recipients)
      return nil
    }
  }
  @objc func listDrafts(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      try JSONSerialization.jsonObject(with: JSONEncoder().encode(ShareStore.drafts()))
    }
  }
  @objc func updateDraft(_ id: String, recipientId: String, message: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      var draft = try ShareStore.draft(id)
      guard try ShareStore.recipients().contains(where: { $0.id == recipientId && $0.macId == draft.macId })
      else { throw ShareStore.failure("Choose an available bot on the original Mac.") }
      guard draft.sentThreadId == nil else { throw ShareStore.failure("This draft was already sent.") }
      draft.recipientId = recipientId
      draft.text = message
      try ShareStore.save(draft)
      return nil
    }
  }
  @objc func markDraftSent(_ id: String, threadId: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      var draft = try ShareStore.draft(id)
      draft.sentThreadId = threadId
      try ShareStore.save(draft)
      return nil
    }
  }
  @objc func removeDraft(_ id: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let url = try ShareStore.draftURL(id)
      if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
      return nil
    }
  }
  @objc func donate(_ value: [String: String], resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      let recipient = try JSONDecoder().decode(ShareRecipient.self, from: JSONSerialization.data(withJSONObject: value))
      // Refresh before donating so a quick send following initial pairing is eligible.
      guard try ShareStore.recipients().contains(recipient) else { resolve(nil); return }
      DispatchQueue.main.async {
        ShareStore.donate(recipient) { error in
          if let error { reject("ZOLT_SHARE", error.localizedDescription, error) }
          else { resolve(nil) }
        }
      }
    } catch { reject("ZOLT_SHARE", error.localizedDescription, error) }
  }
}
