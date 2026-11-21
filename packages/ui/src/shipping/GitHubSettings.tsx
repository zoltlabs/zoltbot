import { GITHUB_BOT_SETTING } from "@zoltbot/protocol";
import { useState } from "react";
import type { ChatConnection, Row } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { shippingError } from "./view.js";
export function GitHubSettings({ connection }: { connection: ChatConnection }) {
  const tasks = (connection.snapshot.entities.task ?? []).filter((t) => t.workspaceId);
  const [taskId, setTaskId] = useState(""),
    [result, setResult] = useState<Row>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const botRow = connection.snapshot.entities.settings?.find(
    (row) => row.key === GITHUB_BOT_SETTING,
  );
  const asBot = botRow?.value === true;
  async function setAsBot(value: boolean) {
    setSaving(true);
    setError("");
    try {
      await connection.call(
        "settings.set",
        // No row yet means nothing to compare against.
        { key: GITHUB_BOT_SETTING, value, expected: botRow ? { value: botRow.value } : {} },
        crypto.randomUUID(),
      );
    } catch {
      setError("The setting couldn’t be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const botLabel = "Post as Zoltbot";
  return (
    <section className="zb-card settings-panel">
      <h2>GitHub shipping</h2>
      <p>
        Uses GitHub CLI authentication on this Mac. Sign in with <code>gh auth login</code>. Git
        push uses your configured Git credentials; Zoltbot does not change them.
      </p>
      <p>
        Managed publishing supports GitHub.com and same-repository branches. Agent MCP connections
        remain separate. Publishing, feedback, and merging require confirmation on the Mac.
      </p>
      <div className="github-bot-setting">
        <label>
          <input
            type="checkbox"
            checked={asBot}
            disabled={connection.status !== "online" || saving}
            onChange={(event) => void setAsBot(event.target.checked)}
          />{" "}
          {botLabel}
        </label>
        <p className="settings-hint">
          Pull requests come from zoltbot[bot] on repositories where the Zoltbot app is installed,
          and from you everywhere else. Needs a Zoltbot account.
          {connection.githubInstallUrl ? (
            <>
              {" "}
              <a href={connection.githubInstallUrl} target="_blank" rel="noreferrer">
                Install on GitHub
              </a>
            </>
          ) : null}
        </p>
      </div>
      {tasks.length ? (
        <>
          <label htmlFor="github-settings-task">Check a task's GitHub setup</label>
          <select
            id="github-settings-task"
            value={taskId || String(tasks[0]?.id)}
            onChange={(e) => setTaskId(e.target.value)}
          >
            {tasks.map((t) => (
              <option key={String(t.id)} value={String(t.id)}>
                {String(t.title)}
              </option>
            ))}
          </select>
          <Button
            disabled={connection.status !== "online" || busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              setResult(undefined);
              try {
                setResult(
                  (await connection.call("shipping.setup", { id: taskId || tasks[0]?.id })) as Row,
                );
              } catch (problem) {
                setError(shippingError(problem));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Checking…" : "Check GitHub setup"}
          </Button>
        </>
      ) : (
        <p>Create a task in a separate Git worktree to check its repository connection.</p>
      )}
      {result ? (
        <output>
          Signed in as @{String(result.account)} ·{" "}
          {((result.remotes ?? []) as Row[]).map((r) => String(r.repository)).join(", ") ||
            "No supported GitHub remote found"}
        </output>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
