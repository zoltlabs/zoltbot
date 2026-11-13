import { expect, it, vi } from "vitest";
import { brokerCellCredentials } from "./credentials.js";

const account = {
  userId: "member",
  sessionId: "native-session",
  orgId: "personal",
  name: "Personal organization",
};
it("pins native token acquisition to its original session before and after a broker reply", async () => {
  let selected = account.sessionId,
    resolve: ((value: unknown) => void) | undefined;
  const request = vi.fn(
      async () =>
        new Promise<unknown>((done) => {
          resolve = done;
        }),
    ),
    client = { cloudRequest: request, sessionId: () => selected },
    credentials = brokerCellCredentials(client, account, "device"),
    pending = credentials(new AbortController().signal),
    refused = expect(pending).rejects.toThrow("account_session_changed");
  selected = "another-session";
  resolve?.({ token: "synthetic-response" });
  await refused;
  expect(request).toHaveBeenCalledOnce();
  await expect(credentials(new AbortController().signal)).rejects.toThrow(
    "account_session_changed",
  );
  expect(request).toHaveBeenCalledOnce();
  expect(() => brokerCellCredentials(client, account, "device")).toThrow("account_session_changed");
});
