import { parse, ViewRecordSchema } from "@zoltbot/protocol";
import { useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { GrantDialog } from "./GrantDialog.js";
import { ImportView, ViewFiles } from "./InstallControls.js";
import { ViewIcon } from "./ViewIcon.js";
import { ViewUpdate } from "./ViewUpdate.js";
import "./views.css";
export default function ViewsSettings({ connection }: { connection: ChatConnection }) {
  const [edit, setEdit] = useState(""),
    [error, setError] = useState("");
  const views = (connection.snapshot.entities.view ?? [])
    .map((row) => parse(ViewRecordSchema, row))
    .filter((view) => !view.removed);
  function call(method: string, params: object) {
    void connection
      .call(method, params, crypto.randomUUID())
      .catch(() => setError("Could not update this view. Try again."));
  }
  return (
    <section className="page-stack" aria-label="Views settings">
      <div>
        <div className="view-header">
          <ImportView connection={connection} />
          <Button data-views-reload onClick={() => call("view.reload", {})}>
            Reload views
          </Button>
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {!views.length ? <p>No views are installed.</p> : null}
      {views.map((view) => (
        <section key={view.id} className="zb-card settings-panel">
          <h2>
            <ViewIcon hash={view.bundleHash} path={view.icon} /> {view.name}
          </h2>
          <p>{view.description}</p>
          <p>
            {view.source === "builtin" ? "Built-in" : "Custom"} · Version {view.version}
            {view.changedAt ? ` · Files changed ${new Date(view.changedAt).toLocaleString()}` : ""}
          </p>
          {view.error ? (
            <p role="alert">
              {view.error.message}
              {view.error.path ? ` (${view.error.path})` : ""}
            </p>
          ) : null}
          <label>
            <input
              type="checkbox"
              checked={view.enabled}
              onChange={(event) =>
                call("view.setEnabled", { id: view.id, enabled: event.target.checked })
              }
            />{" "}
            Enabled
          </label>
          <p>Permissions: {view.granted.length ? view.granted.join(", ") : "None"}</p>
          <ViewUpdate record={view} connection={connection} />
          <div className="view-header">
            {view.source === "builtin" ? (
              <Button
                disabled={!view.bundleHash || !!view.error}
                onClick={() => call("view.customize", { id: view.id })}
              >
                Customize
              </Button>
            ) : null}
            <ViewFiles record={view} connection={connection} />
            <Button onClick={() => setEdit(view.id)} disabled={!view.bundleHash}>
              Edit permissions
            </Button>
            <Button onClick={() => useShell.getState().openView(view.id)}>Open view</Button>
          </div>
          <GrantDialog
            record={view}
            connection={connection}
            open={edit === view.id}
            onClose={() => setEdit("")}
          />
        </section>
      ))}
    </section>
  );
}
