import type { Shipping } from "@zoltbot/protocol";
import type { ChatConnection, Row } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { attention, summary } from "./view.js";
import "./shipping.css";

export function ShippingRow({ task, connection }: { task: Row; connection: ChatConnection }) {
  const open = useShell((s) => s.openShipping);
  const binding = connection.snapshot.entities.shipping?.find((r) => r.taskId === task.id) as
    | Shipping
    | undefined;
  if (!binding && task.workspaceMode !== "worktree") return null;
  return (
    <div className="shipping-row">
      <Button
        size="sm"
        onClick={() => open(String(task.id))}
        aria-label={`Open shipping for ${String(task.title)}`}
      >
        {binding ? summary(binding) : "Pull request…"}
      </Button>
      {binding && attention(binding) ? (
        <span className="shipping-attention">GitHub needs attention</span>
      ) : null}
    </div>
  );
}
