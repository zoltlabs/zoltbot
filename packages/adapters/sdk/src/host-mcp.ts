import type { OpenOptions } from "./interface.js";

/** A missing or mismatched variable must fail before writing provider configuration. */
export function hostMcpTokenEnvironment(
  options: Pick<OpenOptions, "hostMcp" | "env">,
): string | undefined {
  const name = options.hostMcp.tokenEnv;
  if (name === undefined) return undefined;
  if (
    !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
    !options.hostMcp.token ||
    options.hostMcp.token.length > 8192 ||
    /[\0\r\n]/.test(options.hostMcp.token) ||
    options.env?.[name] !== options.hostMcp.token
  )
    throw new Error("host_mcp_environment_invalid");
  return name;
}
