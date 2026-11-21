// Types for desktop-targets.mjs, which package-desktop.mjs runs as plain JavaScript.
export const DESKTOP_PLATFORMS: readonly ("darwin" | "win32" | "linux")[];
export function desktopTarget(
  platform: string,
  cpu: string,
  versions: { node: string; sqlite: string; abi: string | number },
  // biome-ignore lint/suspicious/noExplicitAny: the target table's shape lives in the script.
): any;
