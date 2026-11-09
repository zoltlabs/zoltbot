import type { QuickServerAccess, QuickTool } from "@zoltbot/protocol";
import { useCallback, useEffect, useState } from "react";
import { Select } from "../components/primitives.js";
import { errorText, type QuickConnectionProp } from "./data.js";

interface Server {
  name: string;
  tools: QuickTool[];
  access: QuickServerAccess;
}
const toolLabels: Record<QuickTool, string> = {
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
};
const accessLabels: Record<QuickServerAccess, string> = {
  ask: "Ask before changes",
  allow: "Always allow",
  off: "Off",
};
/**
 * The MCP servers configured in this Mac's coding tools, and how Quick Chat treats each. Off keeps
 * a server out of Quick Chat entirely, so its tools cost nothing on ordinary questions.
 */
export function QuickServers({ connection }: { connection: QuickConnectionProp }) {
  const [servers, setServers] = useState<Server[]>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setServers(((await connection.call("quickChat.servers", {})) as { items: Server[] }).items);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [connection]);
  useEffect(() => {
    void load();
  }, [load]);
  const change = async (name: string, access: QuickServerAccess) => {
    setError("");
    setServers((rows) => rows?.map((row) => (row.name === name ? { ...row, access } : row)));
    try {
      await connection.call(
        "quickChat.setServer",
        { name, access },
        `quick-server-${crypto.randomUUID()}`,
      );
    } catch (failure) {
      setError(errorText(failure));
      void load();
    }
  };
  if (!servers) return null;
  return (
    <>
      {servers.length ? (
        <ul className="quick-connection-list" aria-label="Your MCP servers">
          {servers.map((server) => (
            <li key={server.name}>
              <span className="grow">
                <strong>{server.name}</strong>{" "}
                <span className="quick-muted">
                  {server.tools.map((tool) => toolLabels[tool]).join(", ")}
                </span>
              </span>
              <Select
                aria-label={`${server.name} in Quick Chat`}
                value={server.access}
                onChange={(event) =>
                  void change(server.name, event.target.value as QuickServerAccess)
                }
              >
                {(["ask", "allow", "off"] as const).map((access) => (
                  <option key={access} value={access}>
                    {accessLabels[access]}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      ) : (
        <p className="quick-muted">
          No MCP servers are set up in Claude Code or Codex on this Mac.
        </p>
      )}
      {error ? (
        <p className="quick-muted" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
