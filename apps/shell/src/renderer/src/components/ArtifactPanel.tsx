import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { ArtifactVersionView } from "../../../shared/documents";
import type { ArtifactSummary } from "../../../shared/ipc";
import { ArtifactCompare, ArtifactTools } from "../documents/ArtifactTools";
import { PanelResizer } from "./PanelResizer";

const KIND_LABELS: Record<string, string> = {
  document: "Document",
  page: "Page",
  design: "Design",
  diagram: "Diagram",
  chart: "Chart",
  image: "Image",
  file: "File",
  code_change: "Code change",
  external: "Link",
};

const KIND_BADGES: Record<string, string> = {
  document: "DOC",
  page: "PAGE",
  design: "UI",
  diagram: "DIAG",
  chart: "CHART",
  image: "IMG",
  file: "FILE",
  code_change: "CODE",
  external: "LINK",
};

export function artifactKindLabel(artifact: ArtifactSummary): string {
  const kind = KIND_LABELS[artifact.kind] ?? "Artifact";
  return artifact.version > 1 ? `${kind} · v${artifact.version}` : kind;
}

export function ArtifactCards(props: {
  artifacts: ArtifactSummary[];
  openVersionId: string | null;
  onOpen: (artifact: ArtifactSummary) => void;
}) {
  return (
    <div class="artifact-cards">
      <For each={props.artifacts}>
        {(artifact) => (
          <button
            type="button"
            class="artifact-card"
            classList={{ "artifact-card-open": props.openVersionId === artifact.versionId }}
            disabled={!artifact.manifestHash}
            aria-label={`Open ${artifact.title}`}
            aria-pressed={props.openVersionId === artifact.versionId}
            onClick={() => props.onOpen(artifact)}
          >
            <span class="file-type-badge artifact-card-badge">
              {KIND_BADGES[artifact.kind] ?? "FILE"}
            </span>
            <span class="artifact-card-text">
              <strong>{artifact.title}</strong>
              <small>
                {artifact.manifestHash ? artifactKindLabel(artifact) : "Files aren’t on this Mac"}
              </small>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

export const ARTIFACT_PANEL_DEFAULT = 440;
export const ARTIFACT_PANEL_MIN = 260;
export const ARTIFACT_PANEL_MAX = 1600;

export function ArtifactPanel(props: {
  artifact: ArtifactSummary;
  width: number;
  maxWidth: () => number;
  onResize: (value: number) => void;
  onResizeEnd: (value: number) => void;
  onClose: () => void;
}) {
  const [frame, setFrame] = createSignal<{ url?: string; error?: string }>({});
  const [attempt, setAttempt] = createSignal(0);
  /** The version on screen: the card's, or an earlier one chosen above the frame. */
  const [shown, setShown] = createSignal<{
    versionId: string;
    number: number;
    manifestHash: string | null;
  }>({
    versionId: props.artifact.versionId,
    number: props.artifact.version,
    manifestHash: props.artifact.manifestHash,
  });
  const [comparing, setComparing] = createSignal(false);
  createEffect(
    on(
      () => props.artifact.versionId,
      () => {
        setShown({
          versionId: props.artifact.versionId,
          number: props.artifact.version,
          manifestHash: props.artifact.manifestHash,
        });
        setComparing(false);
      },
      { defer: true },
    ),
  );
  const show = (version: ArtifactVersionView) => {
    setShown({
      versionId: version.versionId,
      number: version.number,
      manifestHash: version.manifestHash,
    });
    setComparing(false);
  };

  createEffect(
    on([() => shown().manifestHash, attempt], ([hash]) => {
      let active = true;
      onCleanup(() => {
        active = false;
      });
      setFrame({});
      if (!hash) {
        setFrame({ error: "This artifact’s files aren’t on this Mac." });
        return;
      }
      window.openbot.artifacts.prepare(hash).then(
        ({ url }) => {
          if (active) setFrame({ url });
        },
        () => {
          if (active) setFrame({ error: "Couldn’t open this artifact." });
        },
      );
    }),
  );

  return (
    <aside
      id="artifact-side-panel"
      class="artifact-panel"
      aria-label={props.artifact.title}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <PanelResizer
        class="right-panel-resizer"
        label="Resize right panel"
        controls="artifact-side-panel"
        direction="right"
        value={props.width}
        defaultValue={ARTIFACT_PANEL_DEFAULT}
        min={ARTIFACT_PANEL_MIN}
        max={props.maxWidth}
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <header class="artifact-panel-header">
        <div class="artifact-panel-title">
          <h2>{props.artifact.title}</h2>
          <span>{artifactKindLabel({ ...props.artifact, version: shown().number })}</span>
        </div>
        <button
          type="button"
          class="agent-settings-nav-button"
          aria-label="Close artifact"
          onClick={() => props.onClose()}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
            <path d="m5 5 10 10M15 5 5 15" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <ArtifactTools
        artifactId={props.artifact.id}
        versionId={props.artifact.versionId}
        title={props.artifact.title}
        comparing={comparing()}
        onShow={show}
        onCompare={setComparing}
      />
      <div class="artifact-panel-body">
        <Show when={comparing()}>
          <ArtifactCompare
            artifactId={props.artifact.id}
            versionId={shown().versionId}
            number={shown().number}
          />
        </Show>
        <Show
          when={!comparing() && frame().url}
          fallback={
            <Show
              when={!comparing() && frame().error}
              fallback={
                <Show when={!comparing()}>
                  <output class="artifact-panel-status">Loading…</output>
                </Show>
              }
            >
              {(error) => (
                <div class="artifact-panel-status">
                  <output>{error()}</output>
                  <Show when={shown().manifestHash}>
                    <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                      Try again
                    </button>
                  </Show>
                </div>
              )}
            </Show>
          }
        >
          {(url) => (
            <iframe
              class="artifact-frame"
              title={props.artifact.title}
              src={url()}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          )}
        </Show>
      </div>
    </aside>
  );
}
