import "./browser.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { type ContextSectionProps, registerContextSection } from "../context/SessionInputsPanel.js";

interface Evidence {
  id: string;
  revision: number;
  generation: number;
  url: string;
  hash: string;
  bytes: number;
  capturedAt: string;
  outcome: string;
  check: string;
  inspection: string;
  observed?: boolean;
  viewport: { width: number; height: number };
}
interface BrowserState {
  selection: unknown;
  binding: {
    session: string;
    runtimeVersion: string;
    mode: string;
    url?: string;
    artifactRoot: string;
  } | null;
  health: string;
  association: string;
  evidence: Evidence[];
}
export function BrowserSettings({ connection }: { connection: ChatConnection }) {
  const [status, setStatus] = useState("Not checked");
  const [pending, setPending] = useState(false);
  const check = useCallback(async () => {
    const result = (await connection.call("browser.readiness", {})) as {
      state: string;
      version: string;
    };
    setStatus(`${result.state.replaceAll("_", " ")} · CLI ${result.version}`);
  }, [connection.call]);
  useEffect(() => {
    void check().catch(() => setStatus("Needs repair"));
  }, [check]);
  return (
    <section className="zb-card settings-panel">
      <h2>Browser</h2>
      <p>Set up Chromium for local browser checks. The download is stored on this Mac.</p>
      <output>{status}</output>
      <Button
        disabled={pending || connection.status !== "online"}
        onClick={async () => {
          setPending(true);
          try {
            await connection.call("browser.setup", { confirmed: true }, crypto.randomUUID());
            await check();
          } catch {
            setStatus("Setup failed. Check network and disk space, then retry.");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? "Setting up…" : "Set up local browser"}
      </Button>
    </section>
  );
}
function EvidenceImage({ item }: { item: Evidence }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    if (!window.zoltDesktop?.browserEvidence) {
      setError("Open on your Mac to view this image.");
      return;
    }
    void window.zoltDesktop
      .browserEvidence(item.id)
      .then((bytes) => {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
        if (alive) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => {
        if (alive) setError("Image unavailable or integrity check failed.");
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id]);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
  }, [expanded]);
  return (
    <article className="zb-card browser-capture">
      <h4>
        Revision {item.revision} · Browser generation {item.generation}
      </h4>
      {url ? (
        <button
          ref={button}
          className="browser-thumbnail"
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Open evidence from revision ${item.revision}`}
        >
          <img src={url} alt={`Captured browser evidence, revision ${item.revision}`} width="240" />
        </button>
      ) : (
        <p>{error || "Loading image…"}</p>
      )}
      <p>
        Captured ·{" "}
        {item.observed
          ? "Observed image-tool delivery"
          : item.inspection === "agent_reported"
            ? "Agent reported inspection"
            : "Inspection not reported"}
      </p>
      <p>
        {item.check} · {item.outcome} (agent reported)
      </p>
      <details>
        <summary>Evidence details</summary>
        <p>{item.url}</p>
        <p>
          {item.viewport.width} × {item.viewport.height} · {item.bytes} bytes · {item.capturedAt}
        </p>
        <code>{item.hash}</code>
      </details>
      {expanded ? (
        <dialog
          ref={dialog}
          aria-label="Browser evidence image"
          onClose={() => {
            setExpanded(false);
            button.current?.focus();
          }}
        >
          <Button onClick={() => dialog.current?.close()}>Close image</Button>
          <img src={url} alt="Full browser evidence" className="browser-full-image" />
        </dialog>
      ) : null}
    </article>
  );
}
export function TaskBrowser({
  connection,
  id,
  title,
}: {
  connection: ChatConnection;
  id: string;
  title: string;
}) {
  const task = connection.snapshot.entities.task?.find((row) => row.id === id);
  const taskState = String(task?.state ?? "");
  const revision = Number(task?.revision ?? 0);
  const [value, setValue] = useState<BrowserState>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [url, setUrl] = useState("");
  const field = useId();
  const load = useCallback(async () => {
    const result = (await connection.call("browser.task", { id })) as BrowserState;
    setValue(result);
    setUrl((current) => current || result.binding?.url || "");
  }, [connection.call, id]);
  useEffect(() => {
    void taskState;
    void revision;
    void load().catch(() => setError("Browser details unavailable."));
  }, [load, taskState, revision]);
  const action = async (action: string) => {
    setPending(true);
    setError("");
    try {
      await connection.call(
        "browser.action",
        { id, action, confirmed: true, ...(url ? { url } : {}) },
        crypto.randomUUID(),
      );
      setConfirm(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Browser action failed");
    } finally {
      setPending(false);
    }
  };
  if (!value?.selection && !value?.binding && !value?.evidence.length) return null;
  return (
    <section className="zb-card browser-panel" aria-label={`Browser evidence for ${title}`}>
      <h3>Browser evidence</h3>
      <p>{value.health.replaceAll("_", " ")} · URL association: user or agent supplied</p>
      <p>
        Pause the agent before taking over. Browser restarts preserve the conversation and saved
        evidence.
      </p>
      <div className="browser-actions">
        <Button disabled={pending} onClick={() => void load()}>
          Refresh browser
        </Button>
        {value.binding ? (
          <>
            {value.binding.mode === "visible" ? (
              <Button
                disabled={pending || value.health === "running" || !value.binding.url}
                onClick={() => void action("open")}
              >
                {value.health === "running" ? "Browser is open" : "Open browser"}
              </Button>
            ) : null}
            <Button disabled={pending} onClick={() => setConfirm(true)}>
              Reopen visibly
            </Button>
            <Button disabled={pending} onClick={() => void action("stop")}>
              Stop browser
            </Button>
          </>
        ) : (
          <p>Browser selection will be frozen when this task starts.</p>
        )}
      </div>
      {confirm ? (
        <fieldset>
          <legend>Restart browser visibly</legend>
          <p>
            Transient cookies and browser state will be lost. No previous submissions will be
            replayed.
          </p>
          <label htmlFor={field}>Safe application URL</label>
          <input id={field} value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button disabled={pending || !url} onClick={() => void action("reopen_visible")}>
            Restart visibly
          </Button>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
        </fieldset>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {value.evidence.length ? (
        <div className="browser-gallery">
          {value.evidence.map((item) => (
            <EvidenceImage key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <p>
          No captures registered. Availability and running state are separate from verification.
        </p>
      )}
    </section>
  );
}
function BrowserContext({ task, connection, mode }: ContextSectionProps) {
  const [binding, setBinding] = useState<BrowserState["binding"]>();
  useEffect(() => {
    if (mode === "preview" || task.id === "draft") return;
    let active = true;
    void connection
      .call("browser.task", { id: task.id })
      .then((v) => {
        if (active) setBinding((v as BrowserState).binding);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connection.call, task.id, mode]);
  const selection = task.browser as { mode: string; url?: string } | undefined;
  return binding ? (
    <>
      <p>
        CLI {binding.runtimeVersion} · {binding.mode} · {binding.session}
      </p>
      <p>{binding.url || "URL not supplied"}</p>
      <p>Generated files: {binding.artifactRoot}</p>
    </>
  ) : (
    <p>
      {selection
        ? `Local isolated browser · ${selection.mode} · ${selection.url || "URL not supplied"}`
        : "Browser verification off. Enable on a fresh task."}
    </p>
  );
}
registerContextSection({
  id: "browser",
  title: "Browser verification",
  render: (props) => <BrowserContext {...props} />,
});
