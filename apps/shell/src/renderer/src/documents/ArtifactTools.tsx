import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import type { ArtifactVersionView } from "../../../shared/documents";
import { ChangesView } from "./ChangesView";
import { errorText } from "./documents-store";

/** Asks the app to show a project's Documents page with `path` open. */
export const OPEN_DOCUMENT_EVENT = "zoltbot:open-document";
export type OpenDocumentDetail = { projectId: string; path: string };

const when = (value: string) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "";

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document";

interface ArtifactToolsProps {
  artifactId: string;
  versionId: string;
  title: string;
  /** Called with the version to show, or with the same one again to return from comparing. */
  onShow: (version: ArtifactVersionView) => void;
  onCompare: (comparing: boolean) => void;
  comparing: boolean;
}

/**
 * Above an artifact: which version shows, comparing a Markdown version with the one before it,
 * and saving a Markdown version into the project as a document to keep writing in.
 */
export function ArtifactTools(props: ArtifactToolsProps) {
  const [info] = createResource(
    () => props.artifactId,
    (id) => window.openbot.documents.artifactVersions(id),
  );
  const [selected, setSelected] = createSignal(props.versionId);
  const [saving, setSaving] = createSignal(false);
  const [path, setPath] = createSignal(`notes/${slug(props.title)}.md`);
  const [saved, setSaved] = createSignal<{ projectId: string; path: string } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    on(
      () => props.versionId,
      (id) => {
        setSelected(id);
        setSaved(null);
        setSaving(false);
      },
      { defer: true },
    ),
  );

  const versions = () => info.latest?.versions ?? [];
  const current = () => versions().find((version) => version.versionId === selected());
  const previous = () => {
    const shown = current();
    return shown ? versions().find((version) => version.number === shown.number - 1) : undefined;
  };

  async function save(event: SubmitEvent) {
    event.preventDefault();
    let target = path().trim().replace(/^\/+/, "");
    if (!target) return;
    if (!/\.(md|markdown|mdx)$/i.test(target)) target = `${target}.md`;
    setError(null);
    try {
      setSaved(
        await window.openbot.documents.saveArtifact({
          artifactId: props.artifactId,
          versionId: selected(),
          path: target,
        }),
      );
      setSaving(false);
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  const openDocument = (detail: OpenDocumentDetail) =>
    window.dispatchEvent(new CustomEvent<OpenDocumentDetail>(OPEN_DOCUMENT_EVENT, { detail }));

  return (
    <div class="artifact-tools">
      <div class="artifact-tools-row">
        <Show when={versions().length > 1}>
          <label class="artifact-version">
            <span class="sr-only">Version</span>
            <select
              value={selected()}
              onChange={(event) => {
                const version = versions().find(
                  (row) => row.versionId === event.currentTarget.value,
                );
                if (!version) return;
                setSelected(version.versionId);
                props.onShow(version);
              }}
            >
              <For each={versions()}>
                {(version) => (
                  <option value={version.versionId}>
                    {`Version ${version.number}${version.by ? ` · ${version.by}` : ""}${version.createdAt ? ` · ${when(version.createdAt)}` : ""}`}
                  </option>
                )}
              </For>
            </select>
          </label>
        </Show>
        <Show when={info.latest?.markdown && previous()}>
          <button
            type="button"
            class="doc-button"
            aria-pressed={props.comparing}
            onClick={() => props.onCompare(!props.comparing)}
          >
            {props.comparing ? "Show this version" : `Compare with version ${previous()?.number}`}
          </button>
        </Show>
        <Show when={info.latest?.markdown && info.latest?.projectId && !saving()}>
          <button
            type="button"
            class="doc-button"
            aria-expanded={saving()}
            onClick={() => {
              setSaving(true);
              setSaved(null);
            }}
          >
            Save as document
          </button>
        </Show>
      </div>
      <Show when={saving()}>
        <form class="artifact-save" onSubmit={(event) => void save(event)}>
          <label for="artifact-save-path">File name in the project folder</label>
          <input
            id="artifact-save-path"
            ref={(element) => requestAnimationFrame(() => element.focus())}
            type="text"
            spellcheck={false}
            value={path()}
            aria-invalid={error() ? "true" : undefined}
            aria-describedby={error() ? "artifact-save-error" : undefined}
            onInput={(event) => setPath(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSaving(false);
              }
            }}
          />
          <Show when={error()}>
            {(message) => (
              <p id="artifact-save-error" class="doc-error">
                {message()}
              </p>
            )}
          </Show>
          <div class="doc-comment-actions">
            <button type="button" class="doc-button" onClick={() => setSaving(false)}>
              Cancel
            </button>
            <button type="submit" class="doc-button doc-button-primary" disabled={!path().trim()}>
              Save
            </button>
          </div>
        </form>
      </Show>
      <Show when={saved()}>
        {(target) => (
          <div class="artifact-saved" role="status">
            <span>Saved to {target().path}.</span>
            <button type="button" class="doc-button" onClick={() => openDocument(target())}>
              Open in Documents
            </button>
          </div>
        )}
      </Show>
      <Show when={info.error}>
        <p class="doc-error">{errorText(info.error)}</p>
      </Show>
    </div>
  );
}

/** The selected Markdown version against the one before it, word by word. */
export function ArtifactCompare(props: { artifactId: string; versionId: string; number: number }) {
  const [texts] = createResource(
    () => ({ id: props.artifactId, versionId: props.versionId, number: props.number }),
    async (input) => {
      const { versions } = await window.openbot.documents.artifactVersions(input.id);
      const previous = versions.find((version) => version.number === input.number - 1);
      if (!previous) throw new Error("There's no earlier version to compare with.");
      const [before, after] = await Promise.all([
        window.openbot.documents.artifactText({
          artifactId: input.id,
          versionId: previous.versionId,
        }),
        window.openbot.documents.artifactText({ artifactId: input.id, versionId: input.versionId }),
      ]);
      return { before, after, previous: previous.number };
    },
  );
  return (
    <Show
      when={texts.latest}
      fallback={
        <p class="artifact-panel-status">{texts.error ? errorText(texts.error) : "Loading…"}</p>
      }
    >
      {(value) => (
        <ChangesView
          kind="compare"
          label={`Changes from version ${value().previous} to version ${props.number}`}
          baseline={value().before}
          current={value().after}
        />
      )}
    </Show>
  );
}
