import AVFoundation
import Foundation
import Speech

struct Header: Decodable {
    let op: String
    let locale: String?
    let onDevice: Bool?
    let source: String?
    let contextualStrings: [String]?
}

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func micStatusString(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .notDetermined: return "not_determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "denied"
    }
}

func speechStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .notDetermined: return "not_determined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "denied"
    }
}

func currentStatus(localeId: String?) -> [String: Any] {
    let resolved = (localeId?.isEmpty == false) ? localeId! : Locale.current.identifier
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: resolved)) ?? SFSpeechRecognizer()
    return [
        "ok": true,
        "microphone": micStatusString(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speech": speechStatusString(SFSpeechRecognizer.authorizationStatus()),
        "available": recognizer?.isAvailable ?? false,
        "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
        "locale": recognizer?.locale.identifier ?? resolved,
    ]
}

guard let lineData = FileHandle.standardInput.availableData.split(separator: 0x0A, maxSplits: 1).first,
      lineData.count <= 32768,
      let header = try? JSONDecoder().decode(Header.self, from: Data(lineData)) else {
    emit(["ok": false, "kind": "error", "code": "invalid_header", "message": "Invalid speech helper request."])
    exit(1)
}

if header.op == "status" {
    emit(currentStatus(localeId: header.locale))
    exit(0)
}

if header.op == "request_permission" {
    let group = DispatchGroup()
    group.enter()
    AVCaptureDevice.requestAccess(for: .audio) { _ in group.leave() }
    group.enter()
    SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
    _ = group.wait(timeout: .now() + 30)
    emit(currentStatus(localeId: header.locale))
    exit(0)
}

guard header.op == "stream" else {
    emit(["ok": false, "kind": "error", "code": "unsupported_op", "message": "Unsupported operation."])
    exit(1)
}

let resolvedLocale = (header.locale?.isEmpty == false) ? header.locale! : Locale.current.identifier
guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: resolvedLocale)) ?? SFSpeechRecognizer(),
      recognizer.isAvailable else {
    emit(["kind": "error", "code": "recognizer_unavailable", "message": "Speech recognition is not available for this language."])
    exit(1)
}

let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if (header.onDevice ?? true) && recognizer.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
}
if let hints = header.contextualStrings {
    request.contextualStrings = Array(hints.prefix(100).map { String($0.prefix(80)) })
}

let done = DispatchSemaphore(value: 0)
var finished = false
let lock = NSLock()
func finish(exitCode: Int32 = 0) {
    lock.lock()
    if finished {
        lock.unlock()
        return
    }
    finished = true
    lock.unlock()
    emit(["kind": "stopped"])
    done.signal()
    exit(exitCode)
}

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        let text = result.bestTranscription.formattedString
        emit([
            "kind": result.isFinal ? "final" : "partial",
            "text": text,
        ])
        if result.isFinal {
            finish(exitCode: 0)
        }
    }
    if let error = error {
        lock.lock()
        let alreadyDone = finished
        lock.unlock()
        if !alreadyDone {
            emit([
                "kind": "error",
                "code": "recognition_failed",
                "message": error.localizedDescription,
            ])
            finish(exitCode: 0)
        }
    }
}

let audioEngine = AVAudioEngine()
if header.source == "microphone" {
    let inputNode = audioEngine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
    }
    do {
        audioEngine.prepare()
        try audioEngine.start()
    } catch {
        emit(["kind": "error", "code": "audio_start_failed", "message": error.localizedDescription])
        finish(exitCode: 1)
    }
}

DispatchQueue.global(qos: .userInitiated).async {
    guard let pcmFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    ) else {
        request.endAudio()
        return
    }
    var totalBytes = 0
    while true {
        let chunk = FileHandle.standardInput.readData(ofLength: 8192)
        if chunk.isEmpty { break }
        if header.source == "microphone" { continue }
        totalBytes += chunk.count
        if totalBytes > 3_840_000 { break }
        let frameCount = AVAudioFrameCount(chunk.count / 2)
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: frameCount) else {
            continue
        }
        buffer.frameLength = frameCount
        chunk.withUnsafeBytes { raw in
            if let base = raw.baseAddress, let channel = buffer.int16ChannelData?[0] {
                memcpy(channel, base, Int(frameCount) * 2)
            }
        }
        request.append(buffer)
    }
    if header.source == "microphone" {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
    }
    request.endAudio()
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) {
        task.finish()
        finish(exitCode: 0)
    }
}

_ = done.wait(timeout: .now() + 125)
finish(exitCode: 0)
