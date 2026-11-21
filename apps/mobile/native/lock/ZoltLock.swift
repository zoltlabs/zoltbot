import Foundation
import React

@objc(ZoltLock)
final class ZoltLock: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func setEnabled(_ on: Bool, after seconds: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      LockCover.shared.setEnabled(on, after: seconds)
      resolve(nil)
    }
  }

  /// Resolves with "unlocked", or "no_passcode" when the phone no longer has a passcode.
  @objc func lock(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      LockCover.shared.lock { outcome in resolve(outcome.rawValue) }
    }
  }
}
