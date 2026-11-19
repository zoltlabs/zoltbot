import { type CloudAccountStatus, IPC_CHANNELS } from "../../shared/ipc";
import type { Handler } from "../../zolt/agent-handlers";
import type { cloudAccount } from "./cloud-account";

type Account = Pick<ReturnType<typeof cloudAccount>, "status" | "signIn" | "signOut" | "cancel">;

const SIGN_IN_ERRORS: Record<string, string> = {
  sign_in_timed_out: "Sign-in timed out. Try again.",
  sign_in_in_progress: "Sign-in is already open in your browser.",
  accounts_not_configured: "This build of Zoltbot can’t sign in.",
  native_account_unavailable: "Zoltbot’s background service isn’t ready. Try again.",
};

/** Keeps only what the renderer shows: who is signed in, never tokens or session lists. */
export function publicAccountStatus(raw: unknown): CloudAccountStatus {
  const value = (raw ?? {}) as {
    configured?: unknown;
    signedIn?: unknown;
    managementUrl?: unknown;
    account?: { user?: { name?: unknown; email?: unknown } };
  };
  const user = value.account?.user;
  const signedIn = value.signedIn === true;
  return {
    configured: value.configured === true,
    signedIn,
    email: signedIn && typeof user?.email === "string" ? user.email : null,
    name: signedIn && typeof user?.name === "string" && user.name ? user.name : null,
    managementUrl: signedIn && typeof value.managementUrl === "string" ? value.managementUrl : null,
  };
}

/** The renderer's cloud account calls and what main does for each. */
export function accountHandlers(account: Account): Record<string, Handler> {
  return {
    [IPC_CHANNELS.accountGetStatus]: async () => publicAccountStatus(await account.status()),
    [IPC_CHANNELS.accountSignIn]: async () => {
      try {
        return publicAccountStatus(await account.signIn());
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "sign_in_cancelled") return publicAccountStatus(await account.status());
        throw new Error(
          SIGN_IN_ERRORS[code] ?? "Couldn’t sign in. Check your connection and try again.",
        );
      }
    },
    [IPC_CHANNELS.accountSignOut]: async () => {
      await account.signOut();
      return publicAccountStatus(await account.status());
    },
    [IPC_CHANNELS.accountCancel]: () => {
      account.cancel();
    },
  };
}
