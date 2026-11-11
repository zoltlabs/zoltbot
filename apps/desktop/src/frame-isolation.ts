const schemes = new Set(["zoltbot-view:", "zoltbot-artifact:"]);
function bundle(value: string | undefined) {
  try {
    const url = new URL(value ?? "");
    return schemes.has(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}
/** Shared by navigation and request hooks; an untrusted frame stays inside one bundle. */
export function frameRequestAllowed(source: string | undefined, target: string, type: string) {
  const from = bundle(source),
    to = bundle(target);
  if (type === "mainFrame") return !to && !from;
  if (type === "subFrame")
    return !!to && (!from || (from.protocol === to.protocol && from.host === to.host));
  if (!from) return true;
  if (
    from.protocol === "zoltbot-view:" &&
    ["image", "media", "other", "script"].includes(type) &&
    /^(?:blob:null\/|data:)/.test(target)
  )
    return true;
  return !!to && from.protocol === to.protocol && from.host === to.host;
}
