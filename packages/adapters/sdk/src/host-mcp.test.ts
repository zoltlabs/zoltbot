import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { hostMcpTokenEnvironment } from "./host-mcp.js";

it("keeps the existing host authorization path unless the host opts into environment credentials", () => {
  expect(
    hostMcpTokenEnvironment({
      hostMcp: { url: "http://127.0.0.1/mcp", token: randomBytes(32).toString("base64url") },
    }),
  ).toBeUndefined();
});
it("accepts only a bound identifier with the exact in-memory host credential", () => {
  const token = randomBytes(32).toString("base64url");
  expect(
    hostMcpTokenEnvironment({
      hostMcp: { url: "http://127.0.0.1/mcp", token, tokenEnv: "ZOLTBOT_HOST_MCP_TOKEN" },
      env: { ZOLTBOT_HOST_MCP_TOKEN: token },
    }),
  ).toBe("ZOLTBOT_HOST_MCP_TOKEN");
  for (const tokenEnv of ["", "bad-name", "A\nB", `\${ENV}`, "A".repeat(129)]) {
    expect(() =>
      hostMcpTokenEnvironment({
        hostMcp: { url: "http://127.0.0.1/mcp", token, tokenEnv },
        env: { [tokenEnv]: token },
      }),
    ).toThrow("host_mcp_environment_invalid");
  }
  for (const value of [undefined, "", "different"]) {
    expect(() =>
      hostMcpTokenEnvironment({
        hostMcp: { url: "http://127.0.0.1/mcp", token, tokenEnv: "ZOLTBOT_HOST_MCP_TOKEN" },
        ...(value === undefined ? {} : { env: { ZOLTBOT_HOST_MCP_TOKEN: value } }),
      }),
    ).toThrow("host_mcp_environment_invalid");
  }
});
