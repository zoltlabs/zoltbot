export const cuaToolDefinition = {
  name: "native_app",
  description:
    "Native macOS apps; browsers use Playwright. status checks setup; connect requests consent and guidance; describe(tool) before call(tool,args); end releases control.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["status", "connect", "describe", "call", "end"] },
      tool: { type: "string" },
      args: { type: "object", additionalProperties: true },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

// Deliberately exclude scripts/batches, browser/profile management, clipboard, app launches,
// menus (which activate on macOS), recordings and desktop input. New driver tools fail closed.
export const cuaReads = new Set(["list_apps", "list_windows", "get_window_state", "verify_state"]);
export const cuaWrites = new Set([
  "click",
  "double_click",
  "right_click",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
]);
export const cuaTools = new Set([...cuaReads, ...cuaWrites]);

export function checkedArgs(tool: string, input: Record<string, unknown>) {
  if (!cuaTools.has(tool)) throw Error("cua_tool_not_supported");
  const args = structuredClone(input);
  for (const key of Object.keys(args))
    if (
      key.startsWith("_") ||
      ["session", "screenshot_out_file", "scope", "capture_scope"].includes(key)
    )
      throw Error("cua_host_owned_or_unsupported_argument");
  if (args.delivery_mode !== undefined && args.delivery_mode !== "background")
    throw Error("cua_foreground_not_supported");
  const target = args.target as Record<string, unknown> | undefined;
  if (
    target &&
    (target.kind !== "window" || args.pid !== undefined || args.window_id !== undefined)
  )
    throw Error("cua_exact_window_required");
  if (!["list_apps", "list_windows"].includes(tool)) {
    const selected = target ?? args;
    if (
      !Number.isSafeInteger(selected.pid) ||
      Number(selected.pid) <= 0 ||
      !Number.isSafeInteger(selected.window_id) ||
      Number(selected.window_id) <= 0
    )
      throw Error("cua_exact_window_required");
  }
  if (cuaWrites.has(tool) && tool !== "set_value") args.delivery_mode = "background";
  return args;
}

export const cuaGuidance = `Use list_apps/list_windows to select the exact live pid/window_id, then a narrow get_window_state. Read the returned screenshot and accessibility tree. Use current snapshot_id:N element_token, never a bare index. A new snapshot invalidates older tokens. Use since:latest for rereads. Pixel coordinates require a fresh screenshot of that exact window at its current size; never guess. After meaningful actions, verify_state or get_window_state must prove the postcondition; a successful call is not proof. Unverifiable, canceled, failed or timed-out input must not be blindly replayed. Driver refusals remain authoritative. Foreground, desktop input, app launch and menus are unavailable in this integration; explain the limit and ask the user to perform the step. Do not use shell, AppleScript or another input route to bypass it. Permission dialogs belong to the user. Playwright remains the browser default. Call end when finished. This is a shared desktop: don't run another controller alongside Zoltbot.`;
