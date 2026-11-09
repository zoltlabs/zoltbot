import {
  type Artifact,
  type ArtifactManifest,
  ArtifactSchema,
  type ArtifactTarget,
  type ArtifactVersion,
  parse,
} from "@zoltbot/protocol";
import { useEffect, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { setInlinePreviews, useInlinePreviews, usePreviewSlot } from "./preview-lifecycle.js";
import { SaveOnline } from "./SaveOnline.js";
import "./artifacts.css";

export function ArtifactFrame({
  manifestHash,
  path,
  title,
}: {
  manifestHash: string;
  path: string;
  title: string;
}) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    // A retry starts a new preparation generation.
    void retry;
    setState({});
    setLoaded(false);
    const prepare = window.zoltDesktop?.prepareArtifact;
    if (!prepare) {
      setState({ error: "Open this artifact on the Mac." });
      return;
    }
    void prepare(manifestHash)
      .then(({ url }) => {
        if (!active) return;
        const target = new URL(url);
        target.pathname = `/${path.split("/").map(encodeURIComponent).join("/")}`;
        setState((previous) => (previous.error ? previous : { url: target.href }));
      })
      .catch(() => {
        if (active) setState({ error: "Artifact files are unavailable. Refresh to retry." });
      });
    return () => {
      active = false;
    };
  }, [manifestHash, path, retry]);
  useEffect(() => {
    if (loaded || state.error) return;
    const timeout = setTimeout(() => setState({ error: "Preview timed out." }), 10000);
    return () => clearTimeout(timeout);
  }, [loaded, state.error]);
  if (state.error)
    return (
      <div>
        <output>{state.error}</output>
        <Button
          size="sm"
          onClick={() => {
            setState({});
            setRetry((n) => n + 1);
          }}
        >
          Retry preview
        </Button>
      </div>
    );
  if (!state.url) return <output>Loading artifact…</output>;
  return (
    <iframe
      className="artifact-frame"
      title={title}
      src={state.url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={() => setState({ error: "Could not display this preview." })}
    />
  );
}

type Detail = {
  artifact: Artifact;
  version: ArtifactVersion;
  manifest: ArtifactManifest | null;
  saveChecks: string[];
};
export function ArtifactPreview({
  connection,
  artifact,
  versionId,
}: {
  connection: ChatConnection;
  artifact: Artifact;
  versionId: string;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError(false);
    void connection
      .call("artifact.get", { id: artifact.id, versionId })
      .then((value) => {
        if (active) setDetail(value as Detail);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [connection.call, artifact.id, versionId]);
  if (error) return <p role="alert">Could not load this version. Expand to retry.</p>;
  if (!detail) return <output>Loading version…</output>;
  if (!detail.manifest || detail.version.metadataOnly)
    return <p>Files not available on this Mac.</p>;
  return (
    <ArtifactFrame
      manifestHash={detail.version.manifestHash}
      path={detail.manifest.entry}
      title={`${artifact.title}, version ${detail.version.number}`}
    />
  );
}
export function ArtifactPanel({
  connection,
  artifact,
  close,
  initialVersionId,
  onRevise,
}: {
  connection: ChatConnection;
  artifact: Artifact;
  close(): void;
  initialVersionId?: string;
  onRevise?: ((target: ArtifactTarget) => void) | undefined;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const [versionId, setVersionId] = useState(initialVersionId ?? artifact.currentVersionId),
    [detail, setDetail] = useState<Detail>(),
    [error, setError] = useState("");
  const versions = (connection.snapshot.entities.artifactVersion ?? [])
    .filter((v) => v.artifactId === artifact.id)
    .sort((a, b) => Number(b.number) - Number(a.number));
  const slot = usePreviewSlot(panel, true, true);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setError("");
    void connection
      .call("artifact.get", { id: artifact.id, versionId })
      .then((value) => {
        if (active) setDetail(value as Detail);
      })
      .catch(() => {
        if (active) setError("Could not load this version.");
      });
    return () => {
      active = false;
    };
  }, [connection.call, artifact.id, versionId]);
  return (
    <section
      ref={panel}
      className="artifact-panel"
      aria-label={`${artifact.title} viewer`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <h2>{artifact.title}</h2>
      <div className="artifact-panel-content">
        <div className="artifact-toolbar">
          <Button size="sm" onClick={close}>
            Close artifact
          </Button>
          <label>
            Version{" "}
            <select
              aria-label="Artifact version"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {versions.map((v) => (
                <option key={String(v.id)} value={String(v.id)}>
                  v{Number(v.number)}
                  {v.id === artifact.currentVersionId ? " · Current" : ""}
                </option>
              ))}
            </select>
          </label>
          <span>
            {artifact.kind} · {artifact.repositoryState.replaceAll("_", " ")}
          </span>
          {versionId !== artifact.currentVersionId ? (
            <Button size="sm" onClick={() => setVersionId(artifact.currentVersionId)}>
              View current version
            </Button>
          ) : null}
          {onRevise ? (
            <Button
              size="sm"
              disabled={!detail || detail.version.held || detail.version.metadataOnly}
              onClick={() => {
                onRevise({ artifactId: artifact.id, versionId });
                close();
              }}
            >
              Revise this version
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert">{error}</p>
        ) : detail ? (
          <>
            {detail.manifest && !detail.version.metadataOnly && (
              <SaveOnline
                key={detail.version.id}
                manifest={detail.manifest}
                hash={detail.version.manifestHash}
                title={artifact.title}
                version={detail.version.number}
                held={detail.version.held}
              />
            )}
            {detail.saveChecks.length ? (
              <ul aria-label="Save checks">
                {detail.saveChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            ) : null}
            <p className="dim">
              {detail.version.note} · {detail.version.producedBy?.provider ?? artifact.provider} · v
              {detail.version.number}
            </p>
            <p className="dim">
              {detail.version.baseVersionId
                ? `Based on v${versions.find((v) => v.id === detail.version.baseVersionId)?.number ?? "unavailable"}`
                : "Base unknown"}
            </p>
            {!["document", "page", "chart", "diagram", "image"].includes(artifact.kind) ? (
              <p>Preview is unavailable for this artifact type.</p>
            ) : detail.manifest && slot ? (
              <ArtifactFrame
                key={detail.version.manifestHash}
                manifestHash={detail.version.manifestHash}
                path={detail.manifest.entry}
                title={`${artifact.title}, version ${detail.version.number}`}
              />
            ) : (
              <p>
                {detail.manifest
                  ? "Another expanded preview is active."
                  : "Files not in repository. Open on the producing Mac."}
              </p>
            )}
          </>
        ) : (
          <output>Loading version…</output>
        )}
      </div>
    </section>
  );
}
export function ThreadArtifacts({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  const [selected, setSelected] = useState<string>();
  const inline = useInlinePreviews();
  const artifacts = (connection.snapshot.entities.artifact ?? [])
    .filter((v) => v.threadId === threadId && v.state !== "archived")
    .map((v) => parse(ArtifactSchema, v));
  const artifact = artifacts.find((v) => v.id === selected);
  if (!artifacts.length) return null;
  return (
    <section className="artifact-cards" aria-label="Conversation artifacts">
      <h2>Artifacts</h2>
      <label className="sm">
        <input
          type="checkbox"
          checked={inline}
          onChange={(event) => setInlinePreviews(event.target.checked)}
        />{" "}
        Interactive previews in chat
      </label>
      {artifacts.map((a) => (
        <article className="artifact-card" key={a.id} aria-label={a.title}>
          <strong>{a.title}</strong>
          <span>
            {a.kind} · {a.repositoryState.replaceAll("_", " ")}
          </span>
          <Button size="sm" onClick={() => setSelected(a.id)}>
            Open {a.title}
          </Button>
        </article>
      ))}
      {artifact ? (
        <ArtifactPanel
          connection={connection}
          artifact={artifact}
          close={() => setSelected(undefined)}
        />
      ) : null}
    </section>
  );
}
