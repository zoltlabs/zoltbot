import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** A private, persistent MCP connection; closing it never stops a shared service. */
export async function connectStdio(command: string, args: string[], env: Record<string, string>) {
  const transport = new StdioClientTransport({ command, args, env, stderr: "ignore" });
  const client = new Client({ name: "zoltbot", version: "0.1.1" });
  try {
    await client.connect(transport, { timeout: 15000 });
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}
