import ActivityKit
import Foundation
import React

/// P3: starts, updates and ends the Live Activity for the app, and hands back its push token so
/// the relay can update it while the app is closed.
@objc(ZoltActivity)
final class ZoltActivity: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @available(iOS 16.1, *)
  private func state(_ value: NSDictionary) -> ZoltActivityAttributes.ContentState {
    let clamp = { (key: String) in max(0, min(999, (value[key] as? NSNumber)?.intValue ?? 0)) }
    let id = (value["topId"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(128)) }
    return .init(working: clamp("working"), needsYou: clamp("needsYou"), topId: id)
  }
  private func top(_ value: NSDictionary?) -> ZoltActivityTop? {
    guard let value, let id = value["interactionId"] as? String, !id.isEmpty else { return nil }
    return ZoltActivityTop(
      interactionId: id,
      threadId: value["threadId"] as? String ?? "",
      title: String((value["title"] as? String ?? "").prefix(120)))
  }

  @objc func isAvailable(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    if #available(iOS 16.2, *) { resolve(ActivityAuthorizationInfo().areActivitiesEnabled) } else { resolve(false) }
  }

  @objc func start(_ counts: NSDictionary, top value: NSDictionary?, macName: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else { resolve(nil); return }
    let next = state(counts)
    ZoltActivityCache.write(top(value))
    Task {
      // One at a time: end any left from an earlier run.
      for old in Activity<ZoltActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
      do {
        let activity = try Activity.request(
          attributes: ZoltActivityAttributes(macName: String(macName.prefix(60))),
          content: .init(state: next, staleDate: nil),
          pushType: .token)
        resolve(activity.id)
      } catch { reject("ZOLT_ACTIVITY", error.localizedDescription, error) }
    }
  }

  @objc func update(_ counts: NSDictionary, top value: NSDictionary?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else { resolve(nil); return }
    let next = state(counts)
    ZoltActivityCache.write(top(value))
    Task {
      for activity in Activity<ZoltActivityAttributes>.activities {
        await activity.update(.init(state: next, staleDate: nil))
      }
      resolve(nil)
    }
  }

  @objc func end(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else { resolve(nil); return }
    ZoltActivityCache.write(nil)
    Task {
      for activity in Activity<ZoltActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
      resolve(nil)
    }
  }

  /// The running activity's push token as hex, or nil if none arrives within ten seconds.
  @objc func pushToken(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *), let activity = Activity<ZoltActivityAttributes>.activities.first
    else { resolve(nil); return }
    let once = Once(resolve)
    Task {
      for await data in activity.pushTokenUpdates {
        once.send(data.map { String(format: "%02x", $0) }.joined())
        return
      }
      once.send(nil)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { once.send(nil) }
  }
}

/// Resolves a promise at most once.
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var resolve: RCTPromiseResolveBlock?
  init(_ resolve: @escaping RCTPromiseResolveBlock) { self.resolve = resolve }
  func send(_ value: Any?) {
    lock.lock()
    let pending = resolve
    resolve = nil
    lock.unlock()
    pending?(value)
  }
}
