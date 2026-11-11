import type { ViewRecord } from "@zoltbot/protocol";
import type { Permission } from "@zoltbot/view-api";
import { useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Dialog } from "../components/primitives.js";
export const grantText: Record<Permission, string> = {
  read: "See your chats, workspaces, pending requests and spending.",
  act: "Send messages to your agents and stop them. Agents act on these messages as if you wrote them.",
  approve:
    "Answer approvals and questions for you. Zoltbot still asks you before anything that allows more than one action.",
};
function GrantEditor({
  record,
  connection,
  open,
  onClose,
  offered = record.requested,
  fresh = false,
}: {
  record: ViewRecord;
  connection: ChatConnection;
  open: boolean;
  onClose(): void;
  offered?: Permission[];
  fresh?: boolean;
}) {
  const [selected, setSelected] = useState(() => {
      const next = new Set(record.granted);
      if (fresh && offered.includes("read")) next.add("read");
      return next;
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      title={`Permissions for ${record.name}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void connection
                .call(
                  "view.setGrants",
                  {
                    id: record.id,
                    permissions: record.requested.filter((permission) => selected.has(permission)),
                    confirmed: true,
                  },
                  crypto.randomUUID(),
                )
                .then(onClose)
                .catch(() => setError("Could not save these permissions. Try again."))
                .finally(() => setBusy(false));
            }}
          >
            Save permissions
          </Button>
        </>
      }
    >
      {offered.map((permission) => (
        <label key={permission} className="view-permission">
          <input
            type="checkbox"
            checked={selected.has(permission)}
            onChange={(event) =>
              setSelected((old) => {
                const next = new Set(old);
                if (event.target.checked) next.add(permission);
                else next.delete(permission);
                return next;
              })
            }
          />
          <span>{grantText[permission]}</span>
        </label>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </Dialog>
  );
}

export function GrantDialog(props: Parameters<typeof GrantEditor>[0]) {
  return props.open ? (
    <GrantEditor
      key={`${props.record.id}:${(props.offered ?? props.record.requested).join(",")}`}
      {...props}
    />
  ) : null;
}
