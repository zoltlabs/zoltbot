// P10: signing in to an app from the phone. The Mac starts the sign-in, the phone's browser
// finishes it, and the app's redirect goes back to the Mac to redeem.
import type { Connection } from "@zoltbot/protocol";

/** Where a phone sign-in returns. Matches the Mac and the cloud broker. */
export const SIGN_IN_RETURN = "zoltbot://connection-done";

export type CatalogApp = {
  id: string;
  name: string;
  description: string;
  availability: "available" | "registration_required" | "unavailable";
  phoneSignIn?: boolean;
};

export type SignInCallback = { state: string; code?: string; iss?: string; error?: string };

/** What the sign-in redirect carried, or undefined when it isn't one. */
export function readRedirect(url: string): SignInCallback | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (`${parsed.protocol}//${parsed.host}${parsed.pathname}` !== SIGN_IN_RETURN) return undefined;
  const params = parsed.searchParams;
  const states = params.getAll("state");
  if (states.length !== 1 || !states[0]) return undefined;
  const out: SignInCallback = { state: states[0] };
  // A repeated value is passed on empty, so the Mac rejects it as its own loopback does.
  for (const name of ["code", "iss", "error"] as const) {
    const values = params.getAll(name);
    if (values.length) out[name] = values.length === 1 ? (values[0] ?? "") : "";
  }
  return out;
}

/** The catalog app a connection was added from, if any. */
export function appOf(connection: Connection) {
  return /^catalog:([a-z_]+):v1$/.exec(connection.source)?.[1];
}

/** Whether the phone can sign this connection in (or again). */
export function canSignIn(connection: Connection, catalog: CatalogApp[]) {
  const app = catalog.find((item) => item.id === appOf(connection));
  return (
    connection.transport.kind === "https" &&
    connection.credentialStatus !== "not_required" &&
    app?.phoneSignIn === true &&
    app.availability === "available"
  );
}

/** Apps the phone can add: signed in through the broker and not added yet. */
export function addableApps(catalog: CatalogApp[], connections: Connection[]) {
  const added = new Set(connections.map(appOf));
  return catalog.filter(
    (item) => item.phoneSignIn === true && item.availability === "available" && !added.has(item.id),
  );
}

/** A short reason a sign-in didn't finish. */
export function signInError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : String(cause);
  if (code.includes("oauth_already_pending")) return "A sign-in for this app is already open.";
  if (code.includes("oauth_phone_unsupported")) return "Sign in to this app on your Mac.";
  if (code.includes("connection_registration_pending")) return "This app isn't available yet.";
  if (code.includes("keychain_unavailable")) return "Your Mac can't store the sign-in right now.";
  if (code.includes("mac_only")) return "Sign in to apps once your Mac is paired.";
  if (code.includes("Not connected to your Mac")) return "Your Mac is offline.";
  if (code.includes("oauth_provider_error"))
    return "The app couldn't finish the sign-in. Try again.";
  return "Sign-in didn't finish. Try again.";
}
