import type { ViewRecord } from "@zoltbot/protocol";
import { useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Dialog } from "../components/primitives.js";
export function ImportView({ connection }: { connection: ChatConnection }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pick = window.zoltDesktop?.pickViewFolder;
  async function install() {
    if (!pick) return;
    setBusy(true);
    setError("");
    try {
      const path = await pick();
      if (path)
        await connection.call("view.import", { path, confirmed: true }, crypto.randomUUID());
    } catch (error) {
      setError(
        error instanceof Error && error.message.includes("view_folder_exists")
          ? "A view with this id is already installed. Remove it before importing this folder."
          : error instanceof Error && error.message.includes("Could not import ")
            ? error.message
            : "Could not import this folder. Check its view.json and files, then try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button disabled={!pick || busy} onClick={() => void install()}>
        Import view
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
export function ViewFiles({
  record,
  connection,
}: {
  record: ViewRecord;
  connection: ChatConnection;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const show = window.zoltDesktop?.showViewFolder;
  const user = record.source === "user" || record.error?.code === "view_invalid_user";
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await connection.call("view.remove", { id: record.id, confirmed: true }, crypto.randomUUID());
      setConfirm(false);
      document.querySelector<HTMLElement>("[data-views-reload]")?.focus();
    } catch {
      setError("Could not remove this view. Reload your views and try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        disabled={!show}
        onClick={() => {
          setError("");
          void show?.({ id: record.id, source: user ? "user" : "builtin" }).catch(() =>
            setError("Could not show this folder."),
          );
        }}
      >
        Show in Finder
      </Button>
      {user ? (
        <Button disabled={busy} onClick={() => setConfirm(true)}>
          Remove
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <Dialog
        open={confirm}
        title={`Remove ${record.name}?`}
        description="These view files will be permanently deleted."
        onClose={() => setConfirm(false)}
        actions={
          <>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Remove view
            </Button>
          </>
        }
      />
    </>
  );
}
