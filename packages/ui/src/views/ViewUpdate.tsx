import type { ViewRecord } from "@zoltbot/protocol";
import { useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Dialog } from "../components/primitives.js";
export function ViewUpdate({
  record,
  connection,
}: {
  record: ViewRecord;
  connection: ChatConnection;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!record.builtinUpdate) return null;
  async function choose(choice: "keep" | "replace" | "copy") {
    setBusy(true);
    setError("");
    try {
      await connection.call(
        "view.resolveUpdate",
        { id: record.id, choice, ...(choice === "replace" ? { confirmed: true } : {}) },
        crypto.randomUUID(),
      );
      setConfirm(false);
    } catch {
      setError("Could not apply this choice. Reload your views and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={`Update for ${record.name}`}>
      <p>Built-in version {record.builtinUpdate.version} is available.</p>
      <div className="view-header">
        <Button disabled={busy} onClick={() => void choose("keep")}>
          Keep mine
        </Button>
        <Button disabled={busy} onClick={() => setConfirm(true)}>
          Use the new version
        </Button>
        <Button disabled={busy} onClick={() => void choose("copy")}>
          Keep both
        </Button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <Dialog
        open={confirm}
        title={`Use the new version of ${record.name}?`}
        description="Your customized files will be permanently deleted."
        onClose={() => setConfirm(false)}
        actions={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void choose("replace")}>
              Use the new version
            </Button>
          </>
        }
      />
    </section>
  );
}
