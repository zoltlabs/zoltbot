import Foundation
import LocalAuthentication
import Security

struct Request: Decodable {
    let op: String
    let account: String
    let value: String?
}

func reply(_ value: [String: Any], status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
    exit(status)
}

do {
    var input = Data()
    while let part = try FileHandle.standardInput.read(upToCount: 65537 - input.count), !part.isEmpty {
        input.append(part)
        if input.count > 65536 { reply(["ok": false], status: 1) }
    }
    let request = try JSONDecoder().decode(Request.self, from: input)
    guard let account = UUID(uuidString: request.account),
          account.uuidString.lowercased() == request.account,
          ["put", "get", "exists", "remove", "replace"].contains(request.op) else {
        reply(["ok": false], status: 1)
    }
    let authentication = LAContext()
    authentication.interactionNotAllowed = true
    // The file based login Keychain also needs its process local UI guard.
    guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else {
        reply(["ok": false], status: 1)
    }
    var query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.zoltbot.secrets.v1",
        kSecAttrAccount as String: request.account,
        kSecUseAuthenticationContext as String: authentication,
    ]
    if request.op == "replace" {
        guard let value = request.value, let data = value.data(using: .utf8), data.count <= 16384 else {
            reply(["ok": false], status: 1)
        }
        reply(["ok": SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecSuccess])
    }
    if request.op == "remove" {
        let status = SecItemDelete(query as CFDictionary)
        reply(["ok": status == errSecSuccess || status == errSecItemNotFound])
    }
    if request.op == "put" {
        guard let value = request.value, let data = value.data(using: .utf8), data.count <= 16384 else {
            reply(["ok": false], status: 1)
        }
        query[kSecValueData as String] = data
        query[kSecAttrLabel as String] = "Zoltbot private value"
        reply(["ok": SecItemAdd(query as CFDictionary, nil) == errSecSuccess])
    }
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    if request.op == "get" { query[kSecReturnData as String] = true }
    else { query[kSecReturnAttributes as String] = true }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if request.op == "exists" {
        guard status == errSecSuccess || status == errSecItemNotFound else { reply(["ok": false]) }
        reply(["ok": true, "found": status == errSecSuccess])
    }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 16384,
          let value = String(data: data, encoding: .utf8) else { reply(["ok": false]) }
    reply(["ok": true, "value": value])
} catch {
    reply(["ok": false], status: 1)
}
