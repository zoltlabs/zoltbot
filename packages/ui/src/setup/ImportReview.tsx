import { useMutation } from "@tanstack/react-query";
import { type ImportItem, importSourceOptions } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { type ImportPreview, importKind, importPreview, selectedImportIds } from "./import-data.js";
import "./setup.css";

export default function ImportReview({
  connection,
  onBack,
}: {
  connection: ChatConnection;
  onBack(count?: number): void;
}) {
  const folderId = useId();
  const pickerButton = useRef<HTMLButtonElement>(null);
  const [pickerFinished, setPickerFinished] = useState(0);
  useEffect(() => {
    if (pickerFinished) pickerButton.current?.focus();
  }, [pickerFinished]);
  const lastSaved = useRef<number | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null),
    previewHeading = useRef<HTMLHeadingElement>(null),
    backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const [picking, setPicking] = useState(false),
    [folderError, setFolderError] = useState("");
  const [consent, setConsent] = useState(false),
    [sources, setSources] = useState(new Set<string>()),
    [codeFolders, setCodeFolders] = useState(""),
    [scanCode, setScanCode] = useState(false),
    [preview, setPreview] = useState<ImportPreview>(),
    [selected, setSelected] = useState(new Set<string>()),
    [filter, setFilter] = useState("all"),
    [page, setPage] = useState(0),
    [saved, setSaved] = useState<number>();
  const invalidate = () => {
    setPreview(undefined);
    setSelected(new Set());
    setPage(0);
    setSaved(undefined);
  };
  const folders = codeFolders
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const read = useMutation({
    mutationFn: async () => {
      if (!consent || (!sources.size && !(scanCode && folders.length)))
        throw new Error("import_consent_required");
      return importPreview(
        await connection.call("import.preview", {
          consent: true,
          sources: [...sources].sort().concat(scanCode ? ["git"] : []),
          ...(scanCode ? { codeFolders: folders } : {}),
        }),
      );
    },
    onSuccess: (value) => {
      setPreview(value);
      setSelected(new Set());
      setPage(0);
      setSaved(undefined);
      requestAnimationFrame(() => previewHeading.current?.focus());
    },
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!preview || !consent || !selected.size) throw new Error("import_selection_required");
      const ids = selectedImportIds(preview, selected);
      await connection.call(
        "import.apply",
        { previewId: preview.id, selected: ids, consent: true },
        `import:${preview.id}`,
      );
      return ids.length;
    },
    onSuccess: (count) => {
      lastSaved.current = count;
      setSaved(count);
      requestAnimationFrame(() => backButton.current?.focus());
    },
  });
  const busy = read.isPending || apply.isPending,
    disabled = picking || busy || connection.status !== "online";
  const visible = preview?.items.filter((item) => filter === "all" || item.kind === filter) ?? [];
  const shown = visible.slice(page * 100, (page + 1) * 100);
  const kindLabel = (kind: string) =>
    kind === "project" ? "Projects" : kind === "session" ? "Session links" : "MCP servers";
  const changeSource = (id: string, checked: boolean) => {
    invalidate();
    setSources((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const changeSelection = (id: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <section className="import-review" aria-label="Optional import review" aria-busy={busy}>
      <header>
        <h1 ref={heading} tabIndex={-1}>
          Bring existing work
        </h1>
        <p className="dim">
          Preview names and locations, then choose metadata to save in Zoltbot. Source folders stay
          unchanged.
        </p>
      </header>
      <section className="card import-options">
        <h2>Choose what to read</h2>
        <fieldset disabled={disabled}>
          <legend>Metadata sources</legend>
          <div className="import-source-grid">
            {importSourceOptions.map((source) => (
              <label key={source.id}>
                <input
                  type="checkbox"
                  checked={sources.has(source.id)}
                  onChange={(event) => changeSource(source.id, event.target.checked)}
                />
                {source.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={scanCode}
            onChange={(event) => {
              invalidate();
              setScanCode(event.target.checked);
            }}
          />
          Scan code folders I choose
        </label>
        {scanCode ? (
          <div className="import-folders">
            <label htmlFor={folderId}>Code folder paths</label>
            <textarea
              id={folderId}
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              aria-describedby={`${folderId}-help`}
              rows={3}
              disabled={disabled}
              value={codeFolders}
              placeholder="/path/to/code"
              onChange={(event) => {
                invalidate();
                setCodeFolders(event.target.value);
              }}
            />
            {window.zoltDesktop?.pickFolders ? (
              <button
                ref={pickerButton}
                className="btn"
                type="button"
                disabled={disabled || picking}
                onClick={async () => {
                  setPicking(true);
                  setFolderError("");
                  try {
                    const selected = await window.zoltDesktop?.pickFolders?.();
                    if (selected?.length) {
                      invalidate();
                      setCodeFolders((current) =>
                        [
                          ...new Set([
                            ...current
                              .split(/\r?\n/)
                              .map((value) => value.trim())
                              .filter(Boolean),
                            ...selected,
                          ]),
                        ].join("\n"),
                      );
                    }
                  } catch {
                    setFolderError(
                      "Folders could not be selected. Try again or enter absolute paths.",
                    );
                  } finally {
                    setPicking(false);
                    setPickerFinished((value) => value + 1);
                  }
                }}
              >
                {picking ? "Choosing folders…" : "Choose folders…"}
              </button>
            ) : null}
            {folderError ? <p role="alert">{folderError}</p> : null}
            <span className="sm dim" id={`${folderId}-help`}>
              Use absolute paths, one per line. Repository discovery is limited to three levels and
              skips build and dependency folders.
            </span>
          </div>
        ) : null}
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={consent}
            onChange={(event) => {
              invalidate();
              setConsent(event.target.checked);
            }}
          />
          Read metadata from these selected sources and folders
        </label>
        <div className="setup-actions">
          <button
            className="btn pri"
            type="button"
            disabled={
              disabled ||
              !consent ||
              (!sources.size && !(scanCode && folders.length)) ||
              (scanCode && !folders.length)
            }
            onClick={() => {
              apply.reset();
              read.mutate();
            }}
          >
            {read.isPending ? "Reading metadata…" : "Preview metadata"}
          </button>
        </div>
      </section>
      {read.isError || apply.isError ? (
        <p role="alert" className="doctor-error">
          {apply.error instanceof Error &&
          apply.error.message.includes("private_value_requires_secure_field")
            ? "Selected metadata includes a known private value. Deselect it before applying. Your selection is preserved."
            : "Metadata could not be confirmed. Your selection is preserved. Review the current items before retrying."}
        </p>
      ) : null}
      {preview ? (
        <section className="card import-results" aria-label="Metadata preview">
          <h2 ref={previewHeading} tabIndex={-1}>
            Review before importing
          </h2>
          <div className="import-counts">
            {(["project", "session", "mcp"] as const).map((kind) => (
              <span className="chip" key={kind}>
                {kindLabel(kind)}: {preview.items.filter((item) => item.kind === kind).length}
              </span>
            ))}
          </div>
          <p className="sm dim">
            Project hints need a verified folder. MCP servers stay disabled until their
            configuration is confirmed. Session links stay external until adopted.
          </p>
          <section className="setup-actions" aria-label="Filter import items">
            {["all", "project", "session", "mcp"].map((kind) => (
              <button
                key={kind}
                className="btn sm"
                type="button"
                aria-pressed={filter === kind}
                onClick={() => {
                  setFilter(kind);
                  setPage(0);
                }}
              >
                {kind === "all" ? "All" : kindLabel(kind)}
              </button>
            ))}
          </section>
          {shown.length ? (
            <>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll metadata tables. */}
              <section className="setup-table-scroll" tabIndex={0} aria-label="Import items table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Keep</th>
                      <th scope="col">Name</th>
                      <th scope="col">Type</th>
                      <th scope="col">Source and location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((item: ImportItem) => (
                      <tr key={item.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Keep ${item.name} from ${item.source}`}
                            checked={selected.has(item.id)}
                            disabled={disabled || saved !== undefined}
                            onChange={(event) => changeSelection(item.id, event.target.checked)}
                          />
                        </td>
                        <th scope="row">{item.name}</th>
                        <td>{importKind(item)}</td>
                        <td>
                          {importSourceOptions.find((source) => source.id === item.source)?.label ??
                            item.source}
                          <br />
                          <code>
                            {item.scopePath ??
                              item.path ??
                              item.nativePath ??
                              "Location not reported"}
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <div className="setup-actions">
                <button
                  className="btn sm"
                  type="button"
                  disabled={disabled || saved !== undefined}
                  onClick={() =>
                    setSelected(
                      (previous) => new Set([...previous, ...shown.map((item) => item.id)]),
                    )
                  }
                >
                  Select this page
                </button>
                <button
                  className="btn sm"
                  type="button"
                  disabled={disabled || saved !== undefined}
                  onClick={() => setSelected(new Set())}
                >
                  Clear selection
                </button>
                <span className="sm dim">{selected.size} selected across this preview</span>
              </div>
            </>
          ) : (
            <p>No matching metadata found.</p>
          )}
          {visible.length > 100 ? (
            <nav className="setup-actions" aria-label="Import pages">
              <button
                className="btn sm"
                type="button"
                disabled={!page}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <span>
                Page {page + 1} of {Math.ceil(visible.length / 100)}
              </span>
              <button
                className="btn sm"
                type="button"
                disabled={(page + 1) * 100 >= visible.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
          <div className="setup-actions">
            <button
              className="btn pri"
              type="button"
              disabled={disabled || !consent || !selected.size || saved !== undefined}
              onClick={() => apply.mutate()}
            >
              {apply.isPending ? "Saving selected metadata…" : "Import selected metadata"}
            </button>
          </div>
          {saved !== undefined ? (
            <output className="doctor-status">
              Saved {saved} selected metadata {saved === 1 ? "item" : "items"}. Items needing a
              folder or configuration stay pending.
            </output>
          ) : null}
        </section>
      ) : null}
      <div className="setup-actions">
        <button
          className="btn"
          type="button"
          disabled={busy}
          ref={backButton}
          onClick={() => onBack(lastSaved.current)}
        >
          Back to coding tools
        </button>
      </div>
    </section>
  );
}
