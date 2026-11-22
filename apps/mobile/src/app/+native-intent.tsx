import { phoneAccountCallback } from "../cloud/account";

/** The system auth session owns this callback. Keep the handoff out of route params. */
export function redirectSystemPath({ path }: { path: string }) {
  const target = path.split(/[?#]/, 1)[0];
  if (
    target === phoneAccountCallback ||
    target === "/account/callback" ||
    target === "account/callback"
  )
    return null;
  return path;
}
