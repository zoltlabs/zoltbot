import { type Connection, compareSessions, terms } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { type ContextSectionProps, registerContextSection } from "./SessionInputsPanel.js";

export function TaskConnectionsContextSection({ connection, task, mode }: ContextSectionProps) {
  const [items, setItems] = useState<{ id: string; name: string; version: number }[]>([]);
  const revision = connection.snapshot.entities.settings?.find(
    (r) => r.key === "connections.revision",
  )?.value;
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    // Revision events refresh the comparison without replacing the frozen inputs.
    void revision;
    let active = true;
    const load = async () => {
      if (mode === "preview") {
        const result = (await connection.call("connection.list", {
          projectId: task.projectId,
        })) as { items: Connection[] };
        if (active)
          setItems(
            result.items.filter(
              (c) => c.enabled && c.profileIds.includes(String(task.ownerAgentId)),
            ),
          );
      } else {
        const result = (await connection.call("snapshot.get", {})) as {
          entities: Record<string, Record<string, unknown>[]>;
        };
        const session = result.entities.session
          ?.filter((s) => s.threadId === task.threadId)
          .sort(compareSessions)[0];
        const config = result.entities.settings?.find(
          (r) => r.key === `runtime.configuration.${session?.id}`,
        )?.value as
          | { launchManifest?: { connections: { id: string; name: string; version: number }[] } }
          | undefined;
        const frozen = config?.launchManifest?.connections ?? [];
        const current = (await connection.call("connection.list", {
          projectId: task.projectId,
        })) as { items: Connection[] };
        if (active) {
          setItems(frozen);
          setChanged(
            frozen.some((item) => {
              const latest = current.items.find((c) => c.id === item.id);
              return !latest || latest.version !== item.version || !latest.enabled;
            }) ||
              current.items.some(
                (c) =>
                  c.enabled &&
                  c.profileIds.includes(String(task.ownerAgentId)) &&
                  !frozen.some((item) => item.id === c.id),
              ),
          );
        }
      }
    };
    void load().catch(() => {
      if (active) setError(true);
    });
    return () => {
      active = false;
    };
  }, [connection.call, task.projectId, task.ownerAgentId, task.threadId, mode, revision]);
  if (error)
    return <output>Connections could not be loaded. Reopen session inputs to retry.</output>;
  return (
    <>
      {mode === "frozen" && changed && (
        <p>Changed since start. New sessions use the latest connection configuration.</p>
      )}
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.name} · v{item.version} ·{" "}
              {mode === "frozen" ? "Attached at start · Not reported" : "Preview"}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No connections attached. Only enabled {terms.workspace.one} and {terms.profile.one}{" "}
          connections are available.
        </p>
      )}
    </>
  );
}
registerContextSection({
  id: "connections",
  title: "Connections",
  render: (props) => <TaskConnectionsContextSection {...props} />,
});
