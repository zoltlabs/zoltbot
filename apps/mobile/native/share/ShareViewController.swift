import UIKit
import Intents
import UniformTypeIdentifiers
import ImageIO

final class ShareViewController: UIViewController {
  private let message = UITextView()
  private let recipientButton = UIButton(type: .system)
  private let saveButton = UIButton(type: .system)
  private let status = UILabel()
  private let photos = UIStackView()
  private var recipients: [ShareRecipient] = []
  private var selected: ShareRecipient?
  private var images: [SharePhoto] = []
  private var loaded = false
  private var finished = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let title = UILabel()
    title.text = "Share to Zoltbot"
    title.font = .preferredFont(forTextStyle: .title2)
    title.adjustsFontForContentSizeCategory = true
    let cancel = UIButton(type: .system)
    cancel.setTitle("Cancel", for: .normal)
    cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
    recipientButton.addTarget(self, action: #selector(pickRecipient), for: .touchUpInside)
    recipientButton.contentHorizontalAlignment = .leading
    recipientButton.titleLabel?.numberOfLines = 0
    recipientButton.accessibilityLabel = "Choose bot"
    message.font = .preferredFont(forTextStyle: .body)
    message.adjustsFontForContentSizeCategory = true
    message.accessibilityLabel = "Shared message"
    message.layer.borderWidth = 1
    message.layer.borderColor = UIColor.separator.cgColor
    message.layer.cornerRadius = 12
    message.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
    message.heightAnchor.constraint(equalToConstant: 180).isActive = true
    photos.axis = .horizontal
    photos.spacing = 8
    photos.distribution = .fillEqually
    status.text = "Loading shared content…"
    status.font = .preferredFont(forTextStyle: .footnote)
    status.adjustsFontForContentSizeCategory = true
    status.numberOfLines = 0
    status.accessibilityTraits = .updatesFrequently
    saveButton.setTitle("Save draft", for: .normal)
    saveButton.isEnabled = false
    saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
    let note = UILabel()
    note.text = "Open Zoltbot after saving to review and send. Nothing is sent until you tap Send in Zoltbot."
    note.font = .preferredFont(forTextStyle: .footnote)
    note.adjustsFontForContentSizeCategory = true
    note.textColor = .secondaryLabel
    note.numberOfLines = 0
    let stack = UIStackView(arrangedSubviews: [cancel, title, recipientButton, message, photos, status, note, saveButton])
    stack.axis = .vertical
    stack.spacing = 16
    let scroll = UIScrollView()
    scroll.keyboardDismissMode = .interactive
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
      saveButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
      recipientButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
    ])
    do {
      recipients = try ShareStore.recipients()
      let intent = extensionContext?.intent as? INSendMessageIntent
      if let suggestedID = intent?.conversationIdentifier {
        selected = recipients.first(where: { $0.id == suggestedID })
      } else { selected = recipients.first }
      updateRecipient()
      loadContents()
    } catch { showError(error) }
  }

  private func updateRecipient() {
    recipientButton.setTitle(selected.map { "To: \($0.name) ▾" } ?? (recipients.isEmpty ? "No bots available" : "Choose bot ▾"), for: .normal)
    saveButton.isEnabled = loaded && selected != nil
    if selected == nil {
      status.text = recipients.isEmpty
        ? "Open Zoltbot and connect to your Mac to make bots available, then share again."
        : "This suggested bot is no longer available. Choose another bot."
    }
  }
  @objc private func pickRecipient() {
    guard !recipients.isEmpty else { return }
    let picker = UIAlertController(title: "Choose bot", message: nil, preferredStyle: .actionSheet)
    for recipient in recipients {
      picker.addAction(UIAlertAction(title: recipient.name, style: .default) { [weak self] _ in
        self?.selected = recipient
        self?.updateRecipient()
      })
    }
    picker.addAction(UIAlertAction(title: "Cancel", style: .cancel))
    picker.popoverPresentationController?.sourceView = recipientButton
    present(picker, animated: true)
  }
  private func showError(_ error: Error) {
    loaded = false
    saveButton.isEnabled = false
    status.text = error.localizedDescription
  }
  @objc private func cancelShare() {
    finished = true
    extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }
  @objc private func save() {
    guard loaded, !finished, let selected else { return }
    saveButton.isEnabled = false
    do {
      guard try ShareStore.recipients().contains(where: { $0.id == selected.id }) else {
        throw ShareStore.failure("This bot is no longer available. Open Zoltbot and share again.")
      }
      guard !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else {
        throw ShareStore.failure("Add a message or photo before saving.")
      }
      let draft = SharedDraft(version: 1, id: UUID().uuidString, createdAt: ISO8601DateFormatter().string(from: Date()),
        macId: selected.macId, recipientId: selected.id, text: message.text, images: images)
      try ShareStore.save(draft, isNew: true)
      finished = true
      extensionContext?.completeRequest(returningItems: nil)
    } catch {
      status.text = error.localizedDescription
      saveButton.isEnabled = true
    }
  }

  private enum Content { case text(String), photo(SharePhoto) }
  private func loadContents() {
    let items = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    guard !items.isEmpty, items.count <= 10 else {
      showError(ShareStore.failure("Share text, a link, or up to five photos.")); return
    }
    let group = DispatchGroup()
    let lock = NSLock()
    var results: [Int: Content] = [:]
    var failure: Error?
    for (index, provider) in items.enumerated() {
      group.enter()
      let complete: (Content?, Error?) -> Void = { content, error in
        lock.lock()
        if let content { results[index] = content }
        if let error { failure = error }
        lock.unlock()
        group.leave()
      }
      if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
          do {
            guard let url else { throw error ?? ShareStore.failure("Could not read this photo. Try sharing it again.") }
            complete(.photo(try Self.photo(url)), nil)
          } catch { complete(nil, error) }
        }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, error in
          if let url = item as? URL, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            complete(.text(url.absoluteString), nil)
          } else { complete(nil, error ?? ShareStore.failure("Only web links are supported.")) }
        }
      } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, error in
          let text = (item as? String) ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) }
          if let text { complete(.text(text), nil) }
          else { complete(nil, error ?? ShareStore.failure("Could not read the shared text.")) }
        }
      } else { complete(nil, ShareStore.failure("Share text, web links, or photos. Files and videos are not supported yet.")) }
    }
    var timedOut = false
    var loadComplete = false
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
      guard let self, !loadComplete, !self.finished else { return }
      timedOut = true
      self.showError(ShareStore.failure("Loading took too long. Cancel and share again."))
    }
    group.notify(queue: .main) { [weak self] in
      guard let self, !self.finished, !timedOut else { return }
      loadComplete = true
      if let failure { self.showError(failure); return }
      var texts: [String] = []
      for index in items.indices {
        switch results[index] {
        case .text(let text): if !texts.contains(text) { texts.append(text) }
        case .photo(let photo): self.images.append(photo)
        case nil: self.showError(ShareStore.failure("Some shared content could not be read.")); return
        }
      }
      let text = texts.joined(separator: "\n\n")
      guard self.images.count <= 5, text.utf8.count <= 16_000 else {
        self.showError(ShareStore.failure("Use up to five photos and at most 16,000 bytes of text.")); return
      }
      self.message.text = text
      for photo in self.images {
        let preview = UIImageView(image: Data(base64Encoded: photo.base64).flatMap(UIImage.init(data:)))
        preview.contentMode = .scaleAspectFit
        preview.heightAnchor.constraint(equalToConstant: 64).isActive = true
        preview.isAccessibilityElement = true
        preview.accessibilityLabel = "Shared photo"
        self.photos.addArrangedSubview(preview)
      }
      self.loaded = true
      self.status.text = "\(self.images.count) photos · Draft stays on this iPhone until you send it."
      self.updateRecipient()
    }
  }
  private static func photo(_ url: URL) throws -> SharePhoto {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
      let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 1024
      ] as CFDictionary)
    else { throw ShareStore.failure("Could not decode this photo.") }
    let image = UIImage(cgImage: thumb)
    for quality in stride(from: 0.7, through: 0.1, by: -0.1) {
      if let data = image.jpegData(compressionQuality: quality), data.count <= 60_000 {
        return SharePhoto(base64: data.base64EncodedString(), mimeType: "image/jpeg")
      }
    }
    throw ShareStore.failure("This photo is too detailed to send. Try a smaller image.")
  }
}
