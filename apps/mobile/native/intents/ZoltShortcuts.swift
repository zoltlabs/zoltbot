import AppIntents
import Foundation
import React

/// P4: tells Siri the agent names changed, and hands the app a draft an action saved.
@objc(ZoltShortcuts)
final class ZoltShortcuts: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func refresh(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    if #available(iOS 16.0, *) { ZoltShortcutsProvider.updateAppShortcutParameters() }
    resolve(nil)
  }

  /// The draft a Siri or Shortcuts action saved for the app to open, once.
  @objc func takeOpenDraft(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(ZoltDrafts.takePending())
  }
}
