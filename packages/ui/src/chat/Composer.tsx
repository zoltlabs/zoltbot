import type { ArtifactTarget, NativeCommand, OutputMode, UserInput } from "@zoltbot/protocol";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { artifactOutputAvailable, OutputControl } from "../artifacts/OutputControl.js";
import { ComparePicker } from "../compare/ComparePicker.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { CommandPicker } from "./CommandPicker.js";
import { attachmentBlockReason, shouldHandleComposerPaste } from "./composer-attachments.js";
import { type ComposerAttachment as Attachment, useComposerDraft } from "./composer-draft.js";
import {
  COMPOSER_PREVIEW_LIMIT,
  composingKey,
  formatMarkdown,
  type MarkdownFormat,
} from "./composer-editing.js";
import { DictationControl, useDictation } from "./Dictation.js";
import { collectContextualStrings } from "./dictation-state.js";

const formattingKey = "zoltbot.composer.formatting";

import { Markdown } from "./Markdown.js";
import { MentionPicker } from "./MentionPicker.js";
import type { ChatConnection } from "./types.js";
import { useComposerAttachments } from "./useComposerAttachments.js";
import "./composer.css";

// Remount all ephemeral editor state when navigation changes the conversation.
export function Composer(props: ComponentProps<typeof ComposerSession>) {
  return <ComposerSession key={props.threadId} {...props} />;
}
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modKey = mac ? "⌘" : "Ctrl";

/** Whether ⌘ (Ctrl elsewhere) is held, so the send button can show what a click will do. */
function useModifierHeld(active: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const update = (event: KeyboardEvent) => setHeld(mac ? event.metaKey : event.ctrlKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, [active]);
  return held;
}

function ComposerSession({
  connection,
  threadId,
  name,
  projectName,
  busy,
  steer,
  images,
  interrupt,
  commands,
  artifactTarget,
  clearArtifactTarget,
  modeControl,
  onCycleMode,
}: {
  connection: ChatConnection;
  threadId: string;
  name: string;
  projectName?: string;
  busy: boolean;
  steer: boolean;
  images: boolean;
  interrupt?: () => Promise<void>;
  commands?: NativeCommand[];
  artifactTarget?: ArtifactTarget | undefined;
  clearArtifactTarget?(): void;
  /** Permission mode picker shown with the composer controls. */
  modeControl?: ReactNode;
  /** Shift+Tab in the editor steps to the next permission mode, as in the native app. */
  onCycleMode?: (() => boolean) | undefined;
}) {
  const [compareProfiles, setCompareProfiles] = useState<string[]>([]);
  // Whether the formatting toolbar is open; remembered across chats on this computer.
  const [formatting, showFormatting] = useState(() => {
    try {
      return localStorage.getItem(formattingKey) === "1";
    } catch {
      return false;
    }
  });
  const setFormatting = (open: boolean) => {
    showFormatting(open);
    try {
      localStorage.setItem(formattingKey, open ? "1" : "0");
    } catch {}
  };
  const compareAttempt = useRef<
    | {
        signature: string;
        commandId: string;
        id: string;
        members: { threadId: string; profileId: string }[];
      }
    | undefined
  >(undefined);
  const comparing = compareProfiles.length > 1;
  const sourceThread = connection.snapshot.entities.thread?.find((r) => r.id === threadId);
  const compareAvailable = !busy && !sourceThread?.taskId && !artifactTarget;
  const handoff = useShell.getState().chatDraft;
  const persisted = useComposerDraft(
    threadId,
    handoff?.threadId === threadId ? handoff.text : undefined,
  );
  const { text: draft, attachments, outputMode } = persisted.draft;
  const setDraft = (text: string) => persisted.update({ text });
  const setOutputMode = (outputMode: OutputMode) => persisted.update({ outputMode });
  const setAttachments = (next: Attachment[] | ((previous: Attachment[]) => Attachment[])) =>
    persisted.update({
      attachments: typeof next === "function" ? next(persisted.current.current.attachments) : next,
    });
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [cursor, setCursor] = useState(0),
    [dismissed, setDismissed] = useState(""),
    [stopping, setStopping] = useState(false);
  const markdown = persisted.draft.markdown ?? true;
  const setMarkdown = (markdown: boolean) => persisted.update({ markdown });
  const modHeld = useModifierHeld(busy && steer);
  const { update } = persisted;
  useEffect(() => {
    if (useShell.getState().chatDraft?.threadId === threadId) {
      update({});
      useShell.getState().clearChatDraft(threadId);
    }
  }, [threadId, update]);
  const editor = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    retryTarget = useRef<string | undefined>(undefined),
    composing = useRef(false),
    sendLock = useRef(false),
    attempt = useRef(persisted.draft.attempt);
  useLayoutEffect(() => {
    const element = editor.current;
    if (element && element.value === draft) {
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
    }
  }, [draft]);
  useEffect(() => {
    if (artifactTarget) editor.current?.focus();
  }, [artifactTarget]);
  const contextualStrings = useMemo(
    () =>
      collectContextualStrings({
        ...(projectName ? { projectName } : {}),
        profileName: name,
        ...(commands ? { commands } : {}),
      }),
    [commands, name, projectName],
  );
  const dictation = useDictation({
    scopeKey: threadId,
    draft,
    disabled: saving,
    contextualStrings,
    editorRef: editor,
    onUpdateDraft: (nextDraft, nextCursor) => {
      setDraft(nextDraft);
      setCursor(nextCursor);
      setDismissed("");
    },
    onError: setError,
  });
  const intake = useComposerAttachments({
    current: persisted.current,
    saving,
    images,
    locked: sendLock,
    setError,
    setAttachments,
  });
  const { attach, remove } = intake;
  const mention = draft.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
  const mentionKey = `${draft}:${cursor}`;
  const mentionOpen = !saving && !!mention && dismissed !== mentionKey;
  const pickerId = `mention-picker-${threadId}`;
  const command = draft.slice(0, cursor).match(/^\/([^\s]*)$/);
  const commandOpen = !comparing && !saving && !!command && dismissed !== mentionKey;
  const commandId = `command-picker-${threadId}`;
  const activePickerId = mentionOpen ? pickerId : commandOpen ? commandId : undefined;
  const chooseCommand = (command: NativeCommand) => {
    const end = cursor + (draft.slice(cursor).match(/^[^\s]*/)?.[0]?.length ?? 0);
    const rest = draft.slice(end);
    const insertion = `/${command.name}${/^\s/.test(rest) ? "" : " "}`;
    setDraft(insertion + rest);
    setCursor(insertion.length);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(insertion.length, insertion.length);
    });
  };
  const dismissMention = () => {
    setDismissed(mentionKey);
    editor.current?.focus();
  };
  const chooseMention = (file: { path: string; label: string }) => {
    const query = mention?.[1] ?? "";
    const start = cursor - query.length - 1;
    const insertion = `@${file.label} `;
    setDraft(draft.slice(0, start) + insertion + draft.slice(cursor));
    const next = start + insertion.length;
    setCursor(next);
    setAttachments((previous) =>
      previous.some((item) => item.path === file.path)
        ? previous
        : [...previous, { path: file.path, name: file.label, image: false, mime: "", bytes: 0 }],
    );
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(next, next);
    });
  };
  const blocked = attachmentBlockReason(attachments, images);
  const applyFormat = (format: MarkdownFormat) => {
    const element = editor.current;
    if (!element || saving || dictation.active || composing.current) return;
    const next = formatMarkdown(draft, element.selectionStart, element.selectionEnd, format);
    setDraft(next.text);
    setCursor(next.end);
    setDismissed("");
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.start, next.end);
    });
  };
  const send = async (mode: "queue" | "steer" | "interrupt") => {
    if (artifactTarget && mode !== "queue") {
      setError("Queue this revision as a new turn, or remove the selected artifact.");
      return;
    }
    if (
      saving ||
      sendLock.current ||
      !!blocked ||
      composing.current ||
      dictation.active ||
      connection.status !== "online" ||
      (!draft.trim() && !attachments.length)
    )
      return;
    const input: UserInput = [];
    if (draft.length) input.push({ type: "text", text: draft });
    for (const file of attachments)
      input.push(
        file.image
          ? {
              type: "image",
              ...(file.base64 ? { base64: file.base64 } : { path: file.path }),
              mimeType: file.mime,
            }
          : { type: "file", path: file.path },
      );
    const params = {
        threadId,
        input,
        mode: mode === "steer" ? "steer" : "queue",
        outputMode,
        ...(artifactTarget ? { artifactTarget } : {}),
      },
      signature = JSON.stringify(params);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: crypto.randomUUID() };
    sendLock.current = true;
    persisted.update({ attempt: attempt.current });
    setSaving(true);
    setError("");
    try {
      if (comparing) {
        if (!compareAvailable || /^\s*\//.test(draft)) {
          setError("Compare needs an idle chat and a prompt without slash commands.");
          return;
        }
        const signature = JSON.stringify({
          input,
          outputMode,
          compareProfiles,
          projectId: sourceThread?.projectId,
          node: sourceThread?.node,
        });
        if (compareAttempt.current?.signature !== signature)
          compareAttempt.current = {
            signature,
            commandId: crypto.randomUUID(),
            id: crypto.randomUUID(),
            members: compareProfiles.map((profileId) => ({
              profileId,
              threadId: crypto.randomUUID(),
            })),
          };
        const creation = compareAttempt.current;
        await connection.call(
          "compare.create",
          {
            value: {
              id: creation.id,
              title: draft.slice(0, 80),
              ceiling: "read_only",
              ...(sourceThread?.projectId ? { projectId: sourceThread.projectId } : {}),
              ...(sourceThread?.node ? { node: sourceThread.node } : {}),
            },
            members: creation.members,
            input,
            outputMode,
          },
          creation.commandId,
        );
        useShell.getState().openCompare(creation.id);
        compareAttempt.current = undefined;
      } else await connection.call("turn.send", params, attempt.current.id);
      persisted.finish();
      clearArtifactTarget?.();
      intake.clear();
      attempt.current = undefined;
      if (mode === "interrupt" && interrupt) {
        try {
          await interrupt();
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (
            !code.includes("interrupt_turn_changed") &&
            !code.includes("interrupt_already_requested")
          )
            setError(
              "Your message is queued. Stopping was not confirmed. Review the native session before continuing.",
            );
        }
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setError(
        code.includes("private_value_requires_secure_field")
          ? "This draft contains a known private value. Remove it before sending a normal message."
          : code.includes("runtime_private_context_required")
            ? "Restore your protected private context before sending this draft."
            : code.includes("private_context_changed")
              ? "Private context changed while sending. Review your draft and try again."
              : code.includes("method_unavailable")
                ? "Connect a coding tool in Setup to send messages."
                : code.includes("auth_required")
                  ? "Sign in to your coding tool in Setup, then try again."
                  : "Your message could not be confirmed. Reconnect and retry; your draft is still here.",
      );
    } finally {
      sendLock.current = false;
      setSaving(false);
    }
  };
  const empty = !draft.trim() && !attachments.length,
    canSteer = busy && !!steer && !artifactTarget && !comparing;
  return (
    <form
      className={`chat-composer${dictation.active ? " dictating" : ""}`}
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send("queue");
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        attach(event.dataTransfer.files);
      }}
    >
      {artifactTarget ? (
        <div className="artifact-revision-chip">
          <span>
            Revise{" "}
            {String(
              connection.snapshot.entities.artifact?.find((a) => a.id === artifactTarget.artifactId)
                ?.title ?? "artifact",
            )}
            {" · v"}
            {String(
              connection.snapshot.entities.artifactVersion?.find(
                (v) => v.id === artifactTarget.versionId,
              )?.number ?? "unavailable",
            )}
          </span>
          <button type="button" disabled={saving} onClick={clearArtifactTarget}>
            Remove artifact target
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : null}
      {persisted.warning ? <output className="sm">{persisted.warning}</output> : null}
      {blocked ? <output className="sm">{blocked}</output> : null}
      {outputMode === "design" ? (
        <p className="sm">
          This conversation keeps {name}.{" "}
          <button
            type="button"
            className="btn sm"
            disabled={saving}
            onClick={() => {
              const project = connection.snapshot.entities.thread?.find(
                (t) => t.id === threadId,
              )?.projectId;
              useShell
                .getState()
                .startDesignTask(draft, typeof project === "string" ? project : undefined);
            }}
          >
            Start a design task with Claude Designer
          </button>
        </p>
      ) : null}
      {commandOpen ? (
        <CommandPicker
          commands={commands}
          query={command?.[1] ?? ""}
          id={commandId}
          onPick={chooseCommand}
          onDismiss={dismissMention}
        />
      ) : null}
      {mentionOpen ? (
        <MentionPicker
          connection={connection}
          threadId={threadId}
          query={mention?.[1] ?? ""}
          id={pickerId}
          onPick={chooseMention}
          onDismiss={dismissMention}
        />
      ) : null}
      {attachments.length ? (
        <ul className="chat-attachments" aria-label="Attachments">
          {attachments.map((file) => (
            <li key={file.path}>
              {file.preview || file.base64 ? (
                <img
                  src={file.preview ?? `data:${file.mime};base64,${file.base64}`}
                  alt={`Preview of ${file.name}`}
                />
              ) : null}
              <span title={file.path}>{file.name}</span>
              <output className="sm">
                {file.status === "preparing"
                  ? "Preparing…"
                  : file.status === "error"
                    ? file.error
                    : file.image
                      ? "Image ready"
                      : "File reference ready"}
              </output>
              {file.status === "error" ? (
                <button
                  type="button"
                  className="btn sm"
                  disabled={saving}
                  aria-label={`Retry ${file.name}`}
                  onClick={() => {
                    if (!intake.retry(file.path)) {
                      retryTarget.current = file.path;
                      picker.current?.click();
                    }
                  }}
                >
                  {" "}
                  {intake.canRetry(file.path) ? "Retry" : "Attach again"}
                </button>
              ) : null}
              <button
                type="button"
                className="btn sm"
                disabled={saving}
                aria-label={`Remove ${file.name}`}
                onClick={() => remove(file.path)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* Formatting stays out of the way: ⌘B and ⌘I always work; the buttons are one click away. */}
      <button
        type="button"
        className="btn sm ghost icon-only composer-format-toggle"
        aria-label="Formatting"
        title="Show formatting"
        aria-pressed={formatting}
        aria-controls={formatting ? `composer-tools-${threadId}` : undefined}
        disabled={saving}
        onClick={() => setFormatting(!formatting)}
      >
        <Icon name="Format" size="sm" />
      </button>
      {formatting ? (
        <fieldset
          id={`composer-tools-${threadId}`}
          className="composer-editor-tools"
          aria-label="Editor controls"
        >
          <button
            type="button"
            className="btn sm"
            disabled={saving}
            aria-pressed={markdown}
            onClick={() => setMarkdown(!markdown)}
          >
            {markdown ? "Markdown" : "Plain text"}
          </button>
          {markdown ? (
            <fieldset aria-label="Markdown formatting">
              {(
                [
                  ["bold", "Bold"],
                  ["italic", "Italic"],
                  ["code", "Code"],
                  ["list", "List"],
                  ["quote", "Quote"],
                ] as const
              ).map(([format, label]) => (
                <button
                  key={format}
                  type="button"
                  className="btn sm"
                  disabled={saving || dictation.active}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => applyFormat(format)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          ) : null}
        </fieldset>
      ) : null}
      <label className="sr-only" htmlFor={`composer-${threadId}`}>
        Message {name}
      </label>
      <textarea
        ref={editor}
        id={`composer-${threadId}`}
        aria-describedby={[`composer-help-${threadId}`, activePickerId].filter(Boolean).join(" ")}
        aria-keyshortcuts={onCycleMode ? "Shift+Tab" : undefined}
        rows={3}
        value={draft}
        disabled={saving}
        placeholder={`Message ${name}. @ for files, / for commands`}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onPaste={(event) => {
          if (
            shouldHandleComposerPaste(
              [...event.clipboardData.files],
              event.clipboardData.getData("text/plain"),
            )
          ) {
            event.preventDefault();
            attach(event.clipboardData.files);
          }
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setCursor(event.target.selectionStart);
          setDismissed("");
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyUp={(event) => {
          dictation.handleKeyUp(event);
        }}
        onKeyDown={(event) => {
          if (composingKey(event.nativeEvent, composing.current)) return;
          if (dictation.handleKeyDown(event)) return;
          if (event.repeat && event.key === "Enter") {
            event.preventDefault();
            return;
          }
          if (
            markdown &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ["b", "i"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            applyFormat(event.key.toLowerCase() === "b" ? "bold" : "italic");
            return;
          }
          if (
            onCycleMode &&
            event.key === "Tab" &&
            event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            !activePickerId &&
            onCycleMode()
          ) {
            // Only a real mode switch consumes Shift+Tab; otherwise focus moves back as usual.
            event.preventDefault();
            return;
          }
          if (activePickerId && event.key === "Escape") {
            event.preventDefault();
            dismissMention();
            return;
          }
          if (
            activePickerId &&
            ["Enter", "ArrowDown", "ArrowUp"].includes(event.key) &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            const options = document
              .getElementById(activePickerId)
              ?.querySelectorAll<HTMLButtonElement>("button[data-picker-option]");
            const option = event.key === "ArrowUp" ? options?.[options.length - 1] : options?.[0];
            if (option || mentionOpen) {
              event.preventDefault();
              if (event.key === "Enter") option?.click();
              else option?.focus();
              return;
            }
          }
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send(
            (event.metaKey || event.ctrlKey) && busy && steer && !artifactTarget
              ? "steer"
              : "queue",
          );
        }}
      />
      {formatting && markdown && draft.trim() && draft.length <= COMPOSER_PREVIEW_LIMIT ? (
        <details className="composer-preview">
          <summary>Markdown preview</summary>
          <Markdown value={draft} />
        </details>
      ) : null}
      {draft.length > COMPOSER_PREVIEW_LIMIT ? (
        <output className="sm">
          Large draft · {draft.length.toLocaleString()} characters. All text remains editable and
          will be sent; preview is paused.
        </output>
      ) : null}
      <div className="composer-row">
        <OutputControl
          value={outputMode}
          onChange={setOutputMode}
          disabled={saving}
          legacy={!artifactOutputAvailable(connection, threadId)}
        />
        <input
          hidden
          ref={picker}
          type="file"
          multiple
          aria-label="Attach files"
          disabled={saving}
          onChange={(event) => {
            attach(event.target.files, retryTarget.current);
            retryTarget.current = undefined;
            event.target.value = "";
          }}
        />
        {compareAvailable ? (
          <ComparePicker
            connection={connection}
            threadId={threadId}
            selected={compareProfiles}
            onChange={setCompareProfiles}
            disabled={saving}
          />
        ) : null}
        {comparing ? null : modeControl}
        <span id={`composer-help-${threadId}`} className="sr-only">
          Shift + Enter for a new line · @ files · / commands and skills
        </span>
        <span className="sp" />
        <button
          type="button"
          className="btn sm ghost icon-only"
          aria-label="Attach"
          title="Attach files"
          disabled={saving}
          onClick={() => {
            retryTarget.current = undefined;
            picker.current?.click();
          }}
        >
          <Icon name="Attach" size="sm" />
        </button>
        <DictationControl dictation={dictation} disabled={saving} iconOnly />
        {busy && interrupt ? (
          <button
            type="button"
            className="btn sm"
            disabled={
              !!artifactTarget ||
              !!blocked ||
              saving ||
              dictation.active ||
              connection.status !== "online" ||
              (!draft.trim() && !attachments.length)
            }
            onClick={() => void send("interrupt")}
          >
            Interrupt and send
          </button>
        ) : null}
        {busy && interrupt && empty ? (
          <button
            type="button"
            className="btn sm bad chat-send"
            aria-label="Stop the response"
            disabled={stopping || connection.status !== "online"}
            onClick={async () => {
              setStopping(true);
              try {
                await interrupt();
              } catch {
                setError(
                  "Stopping was not confirmed. Review the native session before continuing.",
                );
              } finally {
                setStopping(false);
              }
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button
            type="submit"
            className="btn sm pri chat-send"
            title={
              canSteer
                ? `Click to queue, ${modKey}-click or ${modKey}↩ to steer the running turn`
                : undefined
            }
            disabled={
              !!blocked || saving || dictation.active || connection.status !== "online" || empty
            }
            onClick={(event) => {
              // ⌘/Ctrl-click does the other thing: steer the running turn instead of queueing.
              if (canSteer && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send("steer");
              }
            }}
          >
            {saving
              ? "Saving…"
              : comparing
                ? `Send to ${compareProfiles.length}`
                : canSteer && modHeld
                  ? "Steer"
                  : busy
                    ? "Queue"
                    : "Send"}
          </button>
        )}
      </div>
    </form>
  );
}
