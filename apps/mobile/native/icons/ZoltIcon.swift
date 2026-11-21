import Foundation
import React
import UIKit

/// P7: the Home Screen icon. iOS shows its own notice when the icon changes.
@objc(ZoltIcon)
final class ZoltIcon: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// The alternate icon's name, or nil for the main icon.
  @objc func current(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      resolve(UIApplication.shared.supportsAlternateIcons ? UIApplication.shared.alternateIconName : nil)
    }
  }

  @objc func choose(_ name: String?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      guard UIApplication.shared.supportsAlternateIcons else {
        reject("ZOLT_ICON", "This iPhone can't change the app icon.", nil)
        return
      }
      UIApplication.shared.setAlternateIconName(name) { error in
        if let error { reject("ZOLT_ICON", error.localizedDescription, error) } else { resolve(nil) }
      }
    }
  }
}
