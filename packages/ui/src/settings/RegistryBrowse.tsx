// I6: find apps in the official MCP registry and add them, turned off, to a workspace.
import type { RegistryItem } from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button, Field, Input } from "../components/primitives.js";

type Call = (method: string, params: unknown, commandId?: string) => Promise<unknown>;

function addError(error: unknown) {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("registry_needs_node")) return "Install Node.js on this Mac to run this app.";
  if (text.includes("registry_needs_uv")) return "Install uv on this Mac to run this app.";
  if (text.includes("registry_server_changed"))
    return "This app changed in the registry since you looked. Search again to see it.";
  if (
    text.includes("registry_server_needs_settings") ||
    text.includes("registry_server_unsupported")
  )
    return "This app can’t be added yet.";
  if (text.includes("registry_unreachable") || text.includes("registry_server_not_found"))
    return "The MCP registry couldn’t be reached. Try again.";
  return "The app couldn’t be added. Try again.";
}

const publisher = (item: RegistryItem) =>
  item.publisher.kind === "github" ? `${item.publisher.name} on GitHub` : item.publisher.name;

/** Why an app can't be added yet, or nothing when it can. */
function blocked(item: RegistryItem) {
  if (item.install === "unsupported") return "Can’t be added yet";
  if (item.needs.length) return `Needs ${item.needs.join(", ")}, which can’t be set yet`;
  return "";
}

export function RegistryBrowse({
  call,
  projects,
  online,
  onChanged,
}: {
  call: Call;
  projects: Row[];
  online: boolean;
  onChanged(): Promise<void>;
}) {
  const open = projects.filter((project) => !project.archived);
  const [chosen, setChosen] = useState("");
  // Projects can arrive after the dialog opens; the first open one is the default.
  const projectId = open.some((project) => String(project.id) === chosen)
    ? chosen
    : String(open[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<RegistryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [added, setAdded] = useState<string[]>([]);
  const [rowError, setRowError] = useState<{ id: string; text: string }>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately repeats a failed search.
  useEffect(() => {
    if (!online) return;
    let active = true;
    const term = query.trim();
    setLoading(true);
    // The registry searches from three characters; fewer shows what's newest.
    const timer = setTimeout(
      () => {
        void call("connection.registry.search", { query: term.length >= 3 ? term : "" })
          .then((result) => {
            if (!active) return;
            setItems((result as { items: RegistryItem[] }).items);
            setError("");
          })
          .catch(() => {
            if (active) setError("The MCP registry couldn’t be reached.");
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      term ? 350 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [call, online, query, retry]);

  async function add(item: RegistryItem) {
    if (busy || !online || !projectId) return;
    if (item.install === "package" && confirming !== item.id) {
      setConfirming(item.id);
      return;
    }
    setBusy(item.id);
    setRowError(undefined);
    try {
      await call(
        "connection.registry.add",
        {
          projectId,
          registryId: item.id,
          // What the owner saw; the Mac refuses the add if the registry changed since.
          version: item.version,
          ...(item.runs ? { runs: item.runs } : {}),
          ...(item.url ? { url: item.url } : {}),
          ...(item.install === "package" ? { executionConfirmed: true } : {}),
        },
        crypto.randomUUID(),
      );
      setAdded((list) => [...list, `${projectId}:${item.id}`]);
      setConfirming(undefined);
      await onChanged();
    } catch (failure) {
      setRowError({ id: item.id, text: addError(failure) });
    } finally {
      setBusy(undefined);
    }
  }

  const workspaceLabel = `Zoltbot ${terms.workspace.one}`;
  const searchLabel = "Search apps";
  const listLabel = "Apps in the MCP registry";
  return (
    <div className="app-catalog registry-browse">
      <div className="registry-browse-filters">
        <Field label={searchLabel}>
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`${searchLabel}…`}
          />
        </Field>
        <Field label={workspaceLabel}>
          <select
            aria-label={workspaceLabel}
            value={projectId}
            onChange={(event) => setChosen(event.target.value)}
          >
            {open.map((project) => (
              <option key={String(project.id)} value={String(project.id)}>
                {String(project.name)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <output aria-live="polite" className="settings-hint">
        {!online ? "Connect to your Mac to browse apps." : loading ? "Searching…" : ""}
      </output>
      {error ? (
        <p role="alert">
          {error} <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>
        </p>
      ) : null}
      <ul className="registry-list" aria-label={listLabel}>
        {items.map((item) => {
          const reason = blocked(item);
          const done = added.includes(`${projectId}:${item.id}`);
          return (
            <li key={item.id} className="registry-row">
              <div className="registry-row-text">
                <h3>{item.title}</h3>
                <p className="settings-hint">
                  {publisher(item)}
                  {item.url ? ` · ${new URL(item.url).host}` : ""}
                </p>
                {item.description ? <p>{item.description}</p> : null}
                <div aria-live="polite">
                  {confirming === item.id && item.runs ? (
                    <p className="app-connect-note">
                      Runs <code>{item.runs}</code> on this Mac.
                    </p>
                  ) : null}
                </div>
                {rowError?.id === item.id ? <p role="alert">{rowError.text}</p> : null}
              </div>
              <div className="registry-row-action">
                {done ? (
                  <span className="settings-hint">Added. Turn it on in Connected apps.</span>
                ) : reason ? (
                  <span className="settings-hint">{reason}</span>
                ) : (
                  <>
                    {confirming === item.id ? (
                      <Button variant="ghost" onClick={() => setConfirming(undefined)}>
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      variant={confirming === item.id ? "primary" : "secondary"}
                      disabled={!online || !projectId || Boolean(busy)}
                      aria-label={`Add ${item.title}`}
                      onClick={() => void add(item)}
                    >
                      {busy === item.id ? "Adding…" : "Add"}
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!loading && !error && online && !items.length && query.trim() ? (
        <p>
          No apps match “{query.trim()}”.{" "}
          <Button variant="ghost" onClick={() => setQuery("")}>
            Clear search
          </Button>
        </p>
      ) : null}
    </div>
  );
}
