import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { DesktopDictationEvent } from "../connection.js";
import { Icon } from "../shell/icons.js";
import {
  applyDictationTranscript,
  captureDictationAnchor,
  type DictationAnchor,
  type DictationSettings,
  formatDictationElapsed,
  matchesDictationShortcut,
  readDictationSettings,
  rollbackDictationAnchor,
  shortcutLabel,
  subscribeDictationSettings,
} from "./dictation-state.js";

export type DictationPhase = "idle" | "starting" | "listening" | "finalizing";

export interface UseDictationOptions {
  scopeKey: string;
  draft: string;
  disabled?: boolean;
  allowDictation?: boolean;
  contextualStrings?: readonly string[];
  editorRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  onUpdateDraft: (nextDraft: string, nextCursor: number) => void;
  onError?: (message: string) => void;
}

const holdThresholdMs = 220;

export function useDictation({
  scopeKey,
  draft,
  disabled = false,
  allowDictation = true,
  contextualStrings,
  editorRef,
  onUpdateDraft,
  onError,
}: UseDictationOptions) {
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [settings, setSettings] = useState<DictationSettings>(() => readDictationSettings());

  const phaseRef = useRef<DictationPhase>("idle");
  const sessionIdRef = useRef<string | undefined>(undefined);
  const anchorRef = useRef<DictationAnchor | undefined>(undefined);
  const draftRef = useRef(draft);
  const onUpdateRef = useRef(onUpdateDraft);
  const onErrorRef = useRef(onError);
  const startedAtRef = useRef(0);
  const holdOriginRef = useRef<"keyboard" | "pointer" | undefined>(undefined);

  draftRef.current = draft;
  onUpdateRef.current = onUpdateDraft;
  onErrorRef.current = onError;

  const setPhaseSync = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => subscribeDictationSettings(() => setSettings(readDictationSettings())), []);

  useEffect(() => {
    if (phase !== "listening" && phase !== "starting") {
      setElapsedMs(0);
      return;
    }
    const started = Date.now();
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - started);
    }, 250);
    return () => clearInterval(interval);
  }, [phase]);

  const focusEditorAt = useCallback(
    (cursor: number) => {
      requestAnimationFrame(() => {
        const element = editorRef.current;
        if (!element) return;
        element.focus();
        try {
          element.setSelectionRange(cursor, cursor);
        } catch {}
      });
    },
    [editorRef],
  );

  const applyTranscript = useCallback(
    (text: string, focusAfter = false) => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const next = applyDictationTranscript(anchor, text);
      onUpdateRef.current(next.draft, next.cursor);
      if (focusAfter) focusEditorAt(next.cursor);
    },
    [focusEditorAt],
  );

  useEffect(() => {
    const bridge = window.zoltDesktop?.dictation;
    if (!bridge) return;
    return bridge.onEvent((event: DesktopDictationEvent) => {
      if (!sessionIdRef.current || event.sessionId !== sessionIdRef.current) return;
      if (event.kind === "partial") {
        if (phaseRef.current === "starting") setPhaseSync("listening");
        applyTranscript(event.text ?? "", false);
        return;
      }
      if (event.kind === "final") {
        applyTranscript(event.text ?? "", true);
        setAnnouncement("Dictation inserted.");
        return;
      }
      if (event.kind === "error") {
        const code = event.code ?? "";
        const message =
          code === "recognizer_unavailable"
            ? "Speech recognition is not available for the selected language."
            : code === "permission_denied"
              ? "Grant microphone and speech recognition access in Settings to dictate."
              : event.message || "Dictation could not complete. Your draft is preserved.";
        onErrorRef.current?.(message);
        sessionIdRef.current = undefined;
        anchorRef.current = undefined;
        holdOriginRef.current = undefined;
        setPhaseSync("idle");
        return;
      }
      if (event.kind === "stopped") {
        const cursor = editorRef.current?.selectionStart ?? draftRef.current.length;
        sessionIdRef.current = undefined;
        anchorRef.current = undefined;
        holdOriginRef.current = undefined;
        setPhaseSync("idle");
        if (event.reason !== "cancelled" && event.reason !== "scope_changed") {
          focusEditorAt(cursor);
        }
      }
    });
  }, [applyTranscript, editorRef, focusEditorAt, setPhaseSync]);

  // Cancel any active session if the conversation/scope changes or component unmounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scopeKey intentionally resets active session on route/thread switch.
  useEffect(() => {
    return () => {
      const activeId = sessionIdRef.current;
      if (activeId) {
        sessionIdRef.current = undefined;
        anchorRef.current = undefined;
        holdOriginRef.current = undefined;
        phaseRef.current = "idle";
        void window.zoltDesktop?.dictation?.cancel(activeId).catch(() => {});
      }
    };
  }, [scopeKey]);

  const start = useCallback(
    async (origin: "keyboard" | "pointer" = "pointer") => {
      if (disabled || !allowDictation || phaseRef.current !== "idle") return;
      const bridge = window.zoltDesktop?.dictation;
      if (!bridge) {
        onErrorRef.current?.("Open the desktop app to use voice dictation.");
        return;
      }
      onErrorRef.current?.("");
      const element = editorRef.current;
      const currentDraft = draftRef.current;
      const selectionStart = element?.selectionStart ?? currentDraft.length;
      const selectionEnd = element?.selectionEnd ?? selectionStart;
      anchorRef.current = captureDictationAnchor(currentDraft, selectionStart, selectionEnd);
      startedAtRef.current = performance.now();
      holdOriginRef.current = origin;
      setPhaseSync("starting");
      setAnnouncement("Listening. Speak now.");
      try {
        const { sessionId } = await bridge.start({
          locale: settings.locale,
          onDevice: settings.onDevice,
          source: "microphone",
          ...(contextualStrings?.length ? { contextualStrings: [...contextualStrings] } : {}),
        });
        if (phaseRef.current === "idle") {
          void bridge.cancel(sessionId).catch(() => {});
          return;
        }
        sessionIdRef.current = sessionId;
        if (phaseRef.current === "starting") setPhaseSync("listening");
      } catch {
        anchorRef.current = undefined;
        holdOriginRef.current = undefined;
        setPhaseSync("idle");
        onErrorRef.current?.(
          "Could not start dictation. Check microphone permissions in Settings.",
        );
      }
    },
    [allowDictation, contextualStrings, disabled, editorRef, setPhaseSync, settings],
  );

  const stop = useCallback(async () => {
    const activeId = sessionIdRef.current;
    if (!activeId || (phaseRef.current !== "listening" && phaseRef.current !== "starting")) return;
    setPhaseSync("finalizing");
    try {
      await window.zoltDesktop?.dictation?.stop(activeId);
    } catch {
      sessionIdRef.current = undefined;
      anchorRef.current = undefined;
      holdOriginRef.current = undefined;
      setPhaseSync("idle");
    }
  }, [setPhaseSync]);

  const cancel = useCallback(() => {
    const activeId = sessionIdRef.current;
    const anchor = anchorRef.current;
    sessionIdRef.current = undefined;
    anchorRef.current = undefined;
    holdOriginRef.current = undefined;
    setPhaseSync("idle");
    setAnnouncement("Dictation cancelled.");
    if (anchor) {
      const restored = rollbackDictationAnchor(anchor);
      onUpdateRef.current(restored.draft, restored.cursor);
      focusEditorAt(restored.cursor);
    }
    if (activeId) {
      void window.zoltDesktop?.dictation?.cancel(activeId).catch(() => {});
    }
  }, [focusEditorAt, setPhaseSync]);

  useEffect(() => {
    if (phase !== "listening" && phase !== "starting") return;
    const onWindowPointerUp = () => {
      if (holdOriginRef.current !== "pointer") return;
      const heldMs = performance.now() - startedAtRef.current;
      if (heldMs >= holdThresholdMs) {
        void stop();
      }
    };
    const onWindowKeyUp = (event: KeyboardEvent) => {
      if (holdOriginRef.current !== "keyboard") return;
      const releasedHoldKey =
        event.key === "Alt" ||
        event.code === "Space" ||
        event.key === " " ||
        event.key === "\u00a0" ||
        event.code === "KeyD" ||
        event.key.toLowerCase() === "d" ||
        event.key === "Meta" ||
        event.key === "Control";
      if (!releasedHoldKey) return;
      const heldMs = performance.now() - startedAtRef.current;
      if (settings.mode === "hold" || heldMs >= holdThresholdMs) {
        event.preventDefault();
        void stop();
      }
    };
    window.addEventListener("pointerup", onWindowPointerUp);
    window.addEventListener("keyup", onWindowKeyUp);
    return () => {
      window.removeEventListener("pointerup", onWindowPointerUp);
      window.removeEventListener("keyup", onWindowKeyUp);
    };
  }, [phase, settings.mode, stop]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (!allowDictation || disabled) return false;
      const activePhase = phaseRef.current;
      if (activePhase === "listening" || activePhase === "starting") {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
          return true;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          void stop();
          return true;
        }
      }
      if (matchesDictationShortcut(event, settings.shortcut)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return true;
        if (activePhase === "idle") {
          void start("keyboard");
        } else if (activePhase === "listening" || activePhase === "starting") {
          void stop();
        }
        return true;
      }
      return false;
    },
    [allowDictation, cancel, disabled, settings.shortcut, start, stop],
  );

  const handleKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLElement>): boolean => {
      if (
        holdOriginRef.current !== "keyboard" ||
        (phaseRef.current !== "listening" && phaseRef.current !== "starting")
      )
        return false;
      const releasedHoldKey =
        event.key === "Alt" ||
        event.code === "Space" ||
        event.key === " " ||
        event.key === "\u00a0" ||
        event.code === "KeyD" ||
        event.key.toLowerCase() === "d" ||
        event.key === "Meta" ||
        event.key === "Control";
      if (!releasedHoldKey) return false;
      const heldMs = performance.now() - startedAtRef.current;
      if (settings.mode === "hold" || heldMs >= holdThresholdMs) {
        event.preventDefault();
        void stop();
        return true;
      }
      return false;
    },
    [settings.mode, stop],
  );

  return {
    phase,
    active: phase !== "idle",
    elapsedMs,
    announcement,
    settings,
    start,
    stop,
    cancel,
    handleKeyDown,
    handleKeyUp,
    onPointerDown: () => {
      if (disabled || !allowDictation) return;
      if (phaseRef.current === "idle") {
        void start("pointer");
      } else if (phaseRef.current === "listening" || phaseRef.current === "starting") {
        void stop();
      }
    },
    onPointerUp: () => {
      if (
        holdOriginRef.current !== "pointer" ||
        (phaseRef.current !== "listening" && phaseRef.current !== "starting")
      )
        return;
      const heldMs = performance.now() - startedAtRef.current;
      if (heldMs >= holdThresholdMs) {
        void stop();
      }
    },
  };
}

export function DictationControl({
  dictation,
  disabled = false,
  label = "Dictate",
  iconOnly = false,
}: {
  dictation: ReturnType<typeof useDictation>;
  disabled?: boolean;
  label?: string;
  /** Just the microphone, as in the composer row; the label stays for screen readers. */
  iconOnly?: boolean;
}) {
  const { phase, active, elapsedMs, announcement, settings } = dictation;
  const hint = shortcutLabel(settings.shortcut);
  return (
    <div className="dictation-controls">
      <output className="sr-only" aria-live="polite">
        {announcement}
      </output>
      {!active ? (
        <button
          type="button"
          className={`btn sm dictation-btn${iconOnly ? " icon-only" : ""}`}
          disabled={disabled}
          aria-label={label}
          title={
            settings.shortcut === "off"
              ? "Hold or click to dictate"
              : `Hold ${hint} or click to dictate`
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            dictation.onPointerDown();
          }}
          onPointerUp={() => dictation.onPointerUp()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void dictation.start("pointer");
            }
          }}
        >
          <Icon name="Mic" size="sm" />
          {iconOnly ? null : <span>{label}</span>}
        </button>
      ) : (
        <fieldset className="dictation-active-pill" aria-label="Active dictation">
          <span className="dictation-dot" aria-hidden="true" />
          <span className="dictation-timer">
            {phase === "finalizing"
              ? "Finishing…"
              : `Listening ${formatDictationElapsed(elapsedMs)}`}
          </span>
          <button
            type="button"
            className="btn sm pri"
            disabled={phase === "finalizing"}
            aria-label="Finish dictation"
            onPointerUp={() => dictation.onPointerUp()}
            onClick={() => void dictation.stop()}
          >
            Done
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={phase === "finalizing"}
            aria-label="Cancel dictation"
            onClick={() => dictation.cancel()}
          >
            Cancel
          </button>
        </fieldset>
      )}
    </div>
  );
}
