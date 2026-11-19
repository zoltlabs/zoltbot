import { viewScheme } from "./view-protocol";

function bundle(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === viewScheme ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps a view frame inside its own bundle. The window never loads a view as its page, and a view
 * reaches only its own files plus the blob and data URLs it creates. Requests from the shell's
 * own frames are left to the shell's Content-Security-Policy.
 */
export function frameRequestAllowed(source: string | undefined, target: string, type: string) {
  const from = bundle(source),
    to = bundle(target);
  if (type === "mainFrame") return !to && !from;
  if (!from) return true;
  if (["image", "media", "other", "script"].includes(type) && /^(?:blob:null\/|data:)/.test(target))
    return true;
  return !!to && from.host === to.host;
}
