import type { PhoneCellConnection } from "./account.js";
import { type PhoneCloudSocket, phoneCloudConnection } from "./connection.js";
import { nativePhoneAccount } from "./native-account.js";

// React Native accepts handshake headers as the third argument to WebSocket.
const NativeWebSocket = globalThis.WebSocket as unknown as new (
  url: string,
  protocols: string[],
  options: { headers: Readonly<Record<string, string>> },
) => PhoneCloudSocket;

export function nativePhoneCloudConnection(owner: PhoneCellConnection["owner"]) {
  const { sessionId, orgId, deviceId } = owner;
  return phoneCloudConnection({
    owner,
    credentials: () => nativePhoneAccount.cellConnection(sessionId, { orgId, deviceId }),
    socket: (url, headers) => new NativeWebSocket(url, [], { headers }),
    watchAuthority: (refuse) =>
      nativePhoneAccount.subscribe(() => {
        if (nativePhoneAccount.sessionId() !== sessionId) refuse();
      }),
  });
}
