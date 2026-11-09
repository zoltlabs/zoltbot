import { type OutputMode, outputModes } from "@zoltbot/protocol";
import { useCallback, useRef, useState } from "react";

export interface ComposerAttachment {
  path: string;
  name: string;
  image: boolean;
  mime: string;
  bytes: number;
  preview?: string;
  base64?: string;
  status?: "preparing" | "ready" | "error";
  error?: string | undefined;
}
export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  outputMode: OutputMode;
  markdown?: boolean;
  attempt?: { signature: string; id: string } | undefined;
}
const empty = (): ComposerDraft => ({ text: "", attachments: [], outputMode: "auto" });
export const composerDraftKey = (threadId: string) =>
  `zoltbot.composerDraft.v1:${encodeURIComponent(threadId)}`;

/** Persist native references / completed image data, never ephemeral object URLs or File objects. */
export function encodeComposerDraft(draft: ComposerDraft): string {
  return JSON.stringify({
    ...draft,
    attachments: draft.attachments.map(({ preview: _preview, ...file }) => file),
  });
}
export function decodeComposerDraft(raw: string | null): ComposerDraft {
  if (!raw) return empty();
  try {
    const value = JSON.parse(raw) as ComposerDraft;
    if (
      typeof value.text !== "string" ||
      !Array.isArray(value.attachments) ||
      !outputModes.some((mode) => mode.value === value.outputMode)
    )
      return empty();
    const attachments = value.attachments
      .filter(
        (file) =>
          file &&
          typeof file.path === "string" &&
          typeof file.name === "string" &&
          typeof file.image === "boolean" &&
          typeof file.mime === "string" &&
          typeof file.bytes === "number" &&
          Number.isFinite(file.bytes) &&
          file.bytes >= 0 &&
          (file.base64 === undefined || typeof file.base64 === "string"),
      )
      .map(
        (file): ComposerAttachment => ({
          path: file.path,
          name: file.name,
          image: file.image,
          mime: file.mime,
          bytes: file.bytes,
          ...(file.base64 ? { base64: file.base64 } : {}),
          status:
            file.status === "preparing" || (file.path.startsWith("image:") && !file.base64)
              ? "error"
              : file.status === "error"
                ? "error"
                : "ready",
          ...(file.status === "preparing" || (file.path.startsWith("image:") && !file.base64)
            ? { error: "Preparation was interrupted. Attach this file again." }
            : typeof file.error === "string"
              ? { error: file.error }
              : {}),
        }),
      );
    return {
      text: value.text,
      attachments,
      outputMode: value.outputMode,
      ...(typeof value.markdown === "boolean" ? { markdown: value.markdown } : {}),
      ...(typeof value.attempt?.id === "string" && typeof value.attempt.signature === "string"
        ? { attempt: value.attempt }
        : {}),
    };
  } catch {
    return empty();
  }
}

/** Synchronous writes close the navigation/reload gap of debounced draft effects. */
export function useComposerDraft(threadId: string, handoff?: string) {
  const [initial] = useState(() => {
    let draft = empty();
    let warning = "";
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(composerDraftKey(threadId));
      draft = decodeComposerDraft(saved);
    } catch {
      warning = "Draft recovery is unavailable in this browser.";
    }
    if (handoff) draft.text = draft.text ? `${draft.text}\n\n${handoff}` : handoff;
    return { draft, warning, saved };
  });
  const [draft, setDraft] = useState(initial.draft);
  const current = useRef(draft);
  const lastSaved = useRef(initial.saved);
  const [warning, setWarning] = useState(initial.warning);
  const update = useCallback(
    (patch: Partial<ComposerDraft>) => {
      const next = { ...current.current, ...patch };
      current.current = next;
      setDraft(next);
      try {
        if (
          !next.text &&
          !next.attachments.length &&
          next.outputMode === "auto" &&
          !next.attempt &&
          next.markdown !== false
        ) {
          localStorage.removeItem(composerDraftKey(threadId));
          lastSaved.current = null;
        } else {
          const saved = encodeComposerDraft(next);
          localStorage.setItem(composerDraftKey(threadId), saved);
          lastSaved.current = saved;
        }
        setWarning("");
      } catch {
        setWarning(
          "This draft is kept in this window only. Browser storage is full or unavailable.",
        );
      }
    },
    [threadId],
  );
  const finish = () => {
    // A send can settle after navigating away and back. Never erase a newer recovered draft.
    try {
      const saved = localStorage.getItem(composerDraftKey(threadId));
      if (saved !== lastSaved.current) return;
    } catch {
      /* The in-memory draft can still clear if storage is unavailable. */
    }
    update({ text: "", attachments: [], outputMode: "auto", attempt: undefined });
  };
  return { draft, current, update, warning, finish };
}
