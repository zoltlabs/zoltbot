import { describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../../shared/ipc";
import { accountHandlers, publicAccountStatus } from "./account-handlers";

const signedIn = {
  configured: true,
  signedIn: true,
  managementUrl: "https://example.com/account",
  account: {
    user: { id: "user", name: "Sam", email: "sam@example.com" },
    sessionId: "session",
    sessions: [{ id: "session", device_name: "Mac", surface: "desktop", last_seen_at: "" }],
  },
};

function fakeAccount() {
  return {
    status: vi.fn(async () => ({ configured: true, signedIn: false })),
    signIn: vi.fn(async () => signedIn as unknown),
    signOut: vi.fn(async () => undefined),
    cancel: vi.fn(),
  };
}

describe("account handlers", () => {
  it("passes only the signed-in person's name and email to the renderer", () => {
    expect(publicAccountStatus(signedIn)).toEqual({
      configured: true,
      signedIn: true,
      email: "sam@example.com",
      name: "Sam",
      managementUrl: "https://example.com/account",
    });
    expect(publicAccountStatus({ configured: false, signedIn: false })).toEqual({
      configured: false,
      signedIn: false,
      email: null,
      name: null,
      managementUrl: null,
    });
  });

  it("signs in, signs out and treats a cancelled sign-in as signed out", async () => {
    const account = fakeAccount();
    const handlers = accountHandlers(account as never);
    await expect(handlers[IPC_CHANNELS.accountSignIn]?.(undefined)).resolves.toMatchObject({
      signedIn: true,
      email: "sam@example.com",
    });
    await expect(handlers[IPC_CHANNELS.accountSignOut]?.(undefined)).resolves.toMatchObject({
      signedIn: false,
    });
    expect(account.signOut).toHaveBeenCalledOnce();

    account.signIn.mockRejectedValueOnce(new Error("sign_in_cancelled"));
    await expect(handlers[IPC_CHANNELS.accountSignIn]?.(undefined)).resolves.toMatchObject({
      signedIn: false,
    });
    account.signIn.mockRejectedValueOnce(new Error("sign_in_timed_out"));
    await expect(handlers[IPC_CHANNELS.accountSignIn]?.(undefined)).rejects.toThrow(
      "Sign-in timed out. Try again.",
    );
    handlers[IPC_CHANNELS.accountCancel]?.(undefined);
    expect(account.cancel).toHaveBeenCalledOnce();
  });
});
