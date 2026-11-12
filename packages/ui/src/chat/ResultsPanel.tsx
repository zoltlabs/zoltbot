import { ArtifactSchema, type ArtifactTarget, parse } from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import { ArtifactComparison } from "../artifacts/ArtifactComparison.js";
import { ArtifactPanel } from "../artifacts/Artifacts.js";
import { visualOptions } from "../artifacts/comparison-data.js";
import { setInlinePreviews, useInlinePreviews } from "../artifacts/preview-lifecycle.js";
import { Button } from "../components/primitives.js";
import { useShell } from "../state.js";
import { Markdown } from "./Markdown.js";
import { threadResults } from "./results-data.js";
import { DiffDialog } from "./tools/DiffDialog.js";
import { ToolRow } from "./tools/ToolRow.js";
import { body, type ChatConnection, text } from "./types.js";
import "./results.css";

export function ResultsPanel({
  connection,
  threadId,
  onClose,
  onRevise,
}: {
  connection: ChatConnection;
  threadId: string;
  onClose(): void;
  onRevise?: ((target: ArtifactTarget) => void) | undefined;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    heading.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const inline = useInlinePreviews();
  const [comparing, setComparing] = useState(false);
  const options = visualOptions(
    connection.snapshot.entities.artifact ?? [],
    connection.snapshot.entities.artifactVersion ?? [],
    [threadId],
  );
  const data = threadResults(connection.snapshot.entities, threadId);
  const [selected, setSelected] = useState<string>(),
    [changes, setChanges] = useState(false);
  const artifact = data.artifacts.find((row) => row.id === selected);
  const files = Array.isArray(data.result?.files)
    ? data.result.files.filter((file): file is string => typeof file === "string")
    : [];
  const empty =
    !data.result &&
    !data.artifacts.length &&
    !data.links.length &&
    !data.diffs.length &&
    !data.tools.length &&
    !data.children.length &&
    !data.requests.length;
  return (
    <aside className="chat-results" aria-label="Results">
      <header className="chat-results-header">
        <h2 ref={heading} tabIndex={-1}>
          Results
        </h2>
        {options.length > 1 ? (
          <Button size="sm" onClick={() => setComparing(true)}>
            Compare
          </Button>
        ) : null}
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      {artifact ? (
        <ArtifactPanel
          key={text(artifact.id)}
          connection={connection}
          artifact={parse(ArtifactSchema, artifact)}
          close={() => setSelected(undefined)}
          onRevise={onRevise}
        />
      ) : (
        <>
          {empty ? <p className="dim sm">Outputs will appear here as the agent works.</p> : null}
          {data.requests.length ? (
            <section>
              <h3>Needs you</h3>
              <ul>
                {data.requests.map((request) => (
                  <li key={text(request.id)}>
                    <Button
                      size="sm"
                      onClick={() => useShell.getState().openRequest(text(request.id))}
                    >
                      {text(request.title) || "Review request"}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.result?.summary ? (
            <section>
              <h3>Outcome</h3>
              <Markdown value={text(data.result.summary)} />
            </section>
          ) : null}
          {data.artifacts.length ? (
            <section>
              <h3>
                Artifacts <span>{data.artifacts.length}</span>
              </h3>
              <ul>
                {data.artifacts.map((row) => (
                  <li key={text(row.id)}>
                    <button
                      className="result-item"
                      type="button"
                      onClick={() => setSelected(text(row.id))}
                    >
                      <strong>{text(row.title)}</strong>
                      <span>{text(row.kind).replaceAll("_", " ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.diffs.length ? (
            <section>
              <h3>Changes</h3>
              <Button size="sm" onClick={() => setChanges(true)}>
                View {new Set(data.diffs.map((diff) => diff.path)).size} changed{" "}
                {new Set(data.diffs.map((diff) => diff.path)).size === 1 ? "file" : "files"}
              </Button>
            </section>
          ) : null}
          {data.tools.length ? (
            <section>
              <h3>Tool results</h3>
              {data.tools.map((item) => (
                <ToolRow key={text(item.id)} id={text(item.id)} value={body(item)} />
              ))}
            </section>
          ) : null}
          {files.length ? (
            <section>
              <h3>Files</h3>
              <ul>
                {files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.links.length ? (
            <section>
              <h3>Links</h3>
              <ul>
                {data.links.map((link) => (
                  <li key={link.url}>
                    <Markdown value={`[${link.label}](${link.url})`} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.children.length ? (
            <section>
              <h3>Delegated work</h3>
              <ul>
                {data.children.map((task) => (
                  <li key={text(task.id)}>
                    {task.threadId ? (
                      <button
                        className="result-item"
                        type="button"
                        onClick={() => useShell.getState().openThread(text(task.threadId))}
                      >
                        <strong>{text(task.title)}</strong>
                        <span>{text(task.state).replaceAll("_", " ")}</span>
                      </button>
                    ) : (
                      <span>
                        {text(task.title)} · {text(task.state)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <label className="results-preview-preference">
        <input
          type="checkbox"
          checked={inline}
          onChange={(event) => setInlinePreviews(event.target.checked)}
        />{" "}
        Previews in chat
      </label>
      {comparing ? (
        <ArtifactComparison
          connection={connection}
          threadIds={[threadId]}
          onClose={() => setComparing(false)}
          onChoose={onRevise}
        />
      ) : null}
      {changes ? (
        <DiffDialog
          title="Latest turn changes"
          diffs={data.diffs}
          onClose={() => setChanges(false)}
        />
      ) : null}
    </aside>
  );
}
