import type { DelimitedPreview, ZipListing } from "@zoltbot/protocol";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import type { AttachmentSummary } from "../../../../shared/ipc";
import { t } from "../../i18n";
import {
  formatFileSize,
  MissingFileError,
  parseInWorker,
  readTextCapped,
  readZipListing,
} from "./file-read";
import "./files.css";

type Loaded =
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "table"; table: DelimitedPreview; cut: boolean }
  | { kind: "zip"; listing: ZipListing };

async function load(attachment: AttachmentSummary): Promise<Loaded | undefined> {
  const url = attachment.previewUrl;
  const kind = attachment.previewKind;
  if (url && kind === "zip") return { kind: "zip", listing: await readZipListing(url) };
  if (!url || (kind !== "text" && kind !== "csv" && kind !== "tsv")) return undefined;
  const { text, cut } = await readTextCapped(url);
  if (kind === "text") return { kind: "text", text, cut };
  return { kind: "table", table: await parseInWorker(text, kind === "csv" ? "," : "\t"), cut };
}

function failure(error: unknown): string {
  return error instanceof MissingFileError ? t("chat.files.missing") : t("chat.files.failed");
}

/** The body of the preview dialog for one file, by its kind (C16). */
export function FilePreview(props: { attachment: AttachmentSummary }) {
  const [loaded] = createResource(() => props.attachment, load);
  const [broken, setBroken] = createSignal(false);
  createEffect(
    on(
      () => props.attachment.id,
      () => setBroken(false),
      { defer: true },
    ),
  );
  const url = () => props.attachment.previewUrl ?? "";
  const kind = () => props.attachment.previewKind;
  return (
    <Show when={!broken()} fallback={<p class="file-preview-note">{t("chat.files.failed")}</p>}>
      <Switch>
        <Match when={kind() === "image" || kind() === "svg"}>
          {/* SVG only ever loads as a picture, so its scripts and links never run. */}
          <img
            class="file-preview-image"
            classList={{ "file-preview-svg": kind() === "svg" }}
            src={url()}
            alt={props.attachment.name}
            onError={() => setBroken(true)}
          />
        </Match>
        <Match when={kind() === "video"}>
          {/* biome-ignore lint/a11y/useMediaCaption: the owner's own files carry no caption track. */}
          <video
            class="file-preview-video"
            src={url()}
            controls
            preload="metadata"
            aria-label={props.attachment.name}
            onError={() => setBroken(true)}
          />
        </Match>
        <Match when={kind() === "pdf"}>
          <iframe class="file-preview-frame" title={props.attachment.name} src={url()} />
        </Match>
        <Match when={kind() === "markdown"}>
          <iframe
            class="file-preview-frame file-preview-markdown"
            title={props.attachment.name}
            sandbox=""
            src={`${url()}?view=markdown`}
          />
        </Match>
        <Match when={loaded.error}>
          <p class="file-preview-note">{failure(loaded.error)}</p>
        </Match>
        <Match when={loaded.loading}>
          <p class="file-preview-note" role="status">
            {t("chat.files.loading")}
          </p>
        </Match>
        <Match when={loaded()?.kind === "text" && (loaded() as Loaded & { kind: "text" })}>
          {(value) => (
            <>
              <pre
                class="file-preview-text"
                tabindex="0"
                role="region"
                aria-label={props.attachment.name}
              >
                {value().text}
              </pre>
              <Show when={value().cut}>
                <p class="file-preview-note">{t("chat.files.cut")}</p>
              </Show>
            </>
          )}
        </Match>
        <Match when={loaded()?.kind === "zip" && (loaded() as Loaded & { kind: "zip" })}>
          {(value) => <ZipList name={props.attachment.name} listing={value().listing} />}
        </Match>
        <Match when={loaded()?.kind === "table" && (loaded() as Loaded & { kind: "table" })}>
          {(value) => <DelimitedTable name={props.attachment.name} {...value()} />}
        </Match>
      </Switch>
    </Show>
  );
}

const NUMBER = /^[-+]?[$€£¥]?\(?[\d.,]+\)?%?$/;

function DelimitedTable(props: { name: string; table: DelimitedPreview; cut: boolean }) {
  const columns = () =>
    Math.max(props.table.header.length, ...props.table.rows.map((r) => r.length));
  const cells = (row: string[]) => Array.from({ length: columns() }, (_, i) => row[i] ?? "");
  // A column whose every filled cell is a number lines up on the right.
  const numeric = createMemo(() =>
    Array.from(
      { length: columns() },
      (_, i) =>
        props.table.rows.some((row) => row[i]?.trim()) &&
        props.table.rows.every((row) => !row[i]?.trim() || NUMBER.test(row[i].trim())),
    ),
  );
  return (
    <>
      <div class="file-preview-table" tabindex="0" role="region" aria-label={props.name}>
        <table>
          <thead>
            <tr>
              <For each={cells(props.table.header)}>
                {(cell, i) => (
                  <th scope="col" classList={{ numeric: numeric()[i()] }}>
                    {cell}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={props.table.rows}>
              {(row) => (
                <tr>
                  <For each={cells(row)}>
                    {(cell, i) => <td classList={{ numeric: numeric()[i()] }}>{cell}</td>}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={props.cut || props.table.total > props.table.rows.length}>
        <p class="file-preview-note">
          {props.cut
            ? t("chat.files.firstRows", { shown: props.table.rows.length })
            : t("chat.files.someRows", {
                shown: props.table.rows.length,
                total: props.table.total,
              })}
        </p>
      </Show>
    </>
  );
}

/** C18: what a ZIP holds. It's listed from the archive's index and never unpacked. */
function ZipList(props: { name: string; listing: ZipListing }) {
  return (
    <>
      <div class="file-preview-table" tabindex="0" role="region" aria-label={props.name}>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("chat.files.zipName")}</th>
              <th scope="col" class="numeric">
                {t("chat.files.zipSize")}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.listing.entries}>
              {(entry) => (
                <tr>
                  <td>{entry.name}</td>
                  <td class="numeric">{formatFileSize(entry.size)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <p class="file-preview-note">
        {props.listing.files > props.listing.entries.length
          ? t("chat.files.zipSomeFiles", {
              shown: props.listing.entries.length,
              files: props.listing.files,
              size: formatFileSize(props.listing.unpacked),
            })
          : t("chat.files.zipFiles", {
              files: props.listing.files,
              size: formatFileSize(props.listing.unpacked),
            })}
      </p>
    </>
  );
}
