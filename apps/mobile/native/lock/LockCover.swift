import LocalAuthentication
import UIKit

/// P2: covers the whole app in its own window, above sheets and action sheets, so nothing shows
/// in the app switcher or while the app is locked. Face ID or the passcode lifts it.
final class LockCover {
  static let shared = LockCover()

  enum Outcome: String { case unlocked, noPasscode = "no_passcode" }

  /// Cover the app switcher snapshot. Set from the app's Lock with Face ID choice.
  private(set) var enabled = false
  private(set) var locked = false
  private var window: UIWindow?
  private var button: UIButton?
  private var waiters: [(Outcome) -> Void] = []
  private var prompting = false
  private var cameBack = false
  /// Seconds in the background before it locks; mirrors data/app-lock.ts so the cover never
  /// lifts for a moment before the app decides to lock.
  private var after: TimeInterval = 60
  private var leftAt: Date?
  /// The app asks to lock a moment after this cover already locked on return; an unlock that
  /// just happened answers that ask, so Face ID doesn't run twice.
  private var unlockedAt: Date?
  private var observing = false

  func setEnabled(_ on: Bool, after seconds: TimeInterval) {
    enabled = on
    after = max(0, seconds)
    observe()
    if !on {
      locked = false
      finish(.unlocked)
      hide()
    }
  }

  /// Shows the locked cover and asks for Face ID when the app is in front.
  func lock(_ done: @escaping (Outcome) -> Void) {
    observe()
    if !locked, let at = unlockedAt, Date().timeIntervalSince(at) < 3 {
      done(.unlocked)
      return
    }
    waiters.append(done)
    locked = true
    show()
    if UIApplication.shared.applicationState == .active { authenticate() }
  }

  private func observe() {
    guard !observing else { return }
    observing = true
    let center = NotificationCenter.default
    center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, self.enabled || self.locked else { return }
      self.show()
    }
    center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.cameBack = true
      if self.leftAt == nil { self.leftAt = Date() }
    }
    center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      let returned = self.cameBack
      self.cameBack = false
      if returned, self.enabled, let left = self.leftAt {
        let away = Date().timeIntervalSince(left)
        if away < 0 || away >= self.after { self.locked = true }
      }
      self.leftAt = nil
      if !self.locked { self.hide(); return }
      // Only a real return asks again; Face ID's own prompt also makes the app inactive.
      if returned && !self.prompting { self.authenticate() }
    }
  }

  private func authenticate() {
    guard locked, !prompting else { return }
    let context = LAContext()
    var problem: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
      // No passcode any more: the lock can't work, so it must not shut the owner out.
      if (problem as? LAError)?.code == .passcodeNotSet || problem?.code == LAError.passcodeNotSet.rawValue {
        locked = false
        hide()
        finish(.noPasscode)
      }
      return
    }
    prompting = true
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Zoltbot") { ok, _ in
      DispatchQueue.main.async {
        self.prompting = false
        guard ok else { return }
        self.unlockedAt = Date()
        self.locked = false
        self.hide()
        self.finish(.unlocked)
      }
    }
  }

  private func finish(_ outcome: Outcome) {
    let pending = waiters
    waiters = []
    for done in pending { done(outcome) }
  }

  private func show() {
    if window == nil {
      guard let scene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState != .unattached })
      else { return }
      let cover = UIWindow(windowScene: scene)
      cover.windowLevel = .alert + 1
      cover.rootViewController = coverController()
      window = cover
    }
    button?.isHidden = !locked
    window?.isHidden = false
    if locked { UIAccessibility.post(notification: .screenChanged, argument: window?.rootViewController?.view) }
  }

  private func hide() {
    window?.isHidden = true
  }

  private func coverController() -> UIViewController {
    let controller = UIViewController()
    let view = controller.view!
    view.backgroundColor = .systemBackground
    view.accessibilityViewIsModal = true
    let icon = UIImageView(image: UIImage(systemName: "lock.fill"))
    icon.tintColor = .secondaryLabel
    icon.isAccessibilityElement = false
    let title = UILabel()
    title.text = "Zoltbot is locked"
    title.font = .preferredFont(forTextStyle: .headline)
    title.adjustsFontForContentSizeCategory = true
    title.accessibilityTraits = .header
    let unlock = UIButton(type: .system)
    unlock.setTitle("Unlock", for: .normal)
    unlock.titleLabel?.font = .preferredFont(forTextStyle: .body)
    unlock.titleLabel?.adjustsFontForContentSizeCategory = true
    unlock.addAction(UIAction { [weak self] _ in self?.authenticate() }, for: .primaryActionTriggered)
    button = unlock
    let stack = UIStackView(arrangedSubviews: [icon, title, unlock])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      unlock.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    return controller
  }
}
