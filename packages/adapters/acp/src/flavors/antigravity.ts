import type { AcpFlavor } from "../flavor.js";

/** Official agy ACP route. Capabilities are negotiated; no editor identity spoofing. */
export function antigravityFlavor(): AcpFlavor {
  return {
    id: "antigravity",
    testedVersions: "1.4.12",
    newSession: antigravityFlavor,
    readOnlyModes: ["plan", "ask"],
    nativeVisibility: "unknown",
    mcpInjection: "session_new",
    instructionInjection: "first_block",
    chooseAuth(methods, env) {
      if (env.GEMINI_API_KEY && methods.some((method) => method.id === "gemini-api-key"))
        return { methodId: "gemini-api-key" };
      // Cached native credentials are used by session/new; interactive login stays visible.
      return undefined;
    },
  };
}
