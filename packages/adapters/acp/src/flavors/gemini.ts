import type { AcpFlavor } from "../flavor.js";

/**
 * A6: Gemini CLI's own ACP route (`gemini --acp`). Its initialize lists oauth-personal,
 * gemini-api-key, vertex-ai and gateway; a saved Google sign-in needs no authenticate call.
 */
export function geminiFlavor(): AcpFlavor {
  return {
    id: "gemini",
    testedVersions: "0.40.1",
    newSession: geminiFlavor,
    readOnlyModes: ["plan"],
    nativeVisibility: "unknown",
    mcpInjection: "session_new",
    instructionInjection: "first_block",
    chooseAuth(methods, env) {
      if (env.GEMINI_API_KEY && methods.some((method) => method.id === "gemini-api-key"))
        return { methodId: "gemini-api-key" };
      return undefined;
    },
  };
}
