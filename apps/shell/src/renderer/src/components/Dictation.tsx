import { type Accessor, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import type { DictationDesktopApi, DictationEvent, DictationStatus } from "../../../shared/ipc";

export type DictationPhase = "idle" | "starting" | "listening" | "finishing";

/** Where dictated text goes: between what was before and after the caret when it started. */
export interface DictationAnchor {
  prefix: string;
  suffix: string;
  initialDraft: string;
}

export function captureDictationAnchor(draft: string, cursor = draft.length): DictationAnchor {
  const at = Math.max(0, Math.min(draft.length, cursor));
  return { prefix: draft.slice(0, at), suffix: draft.slice(at), initialDraft: draft };
}

export function applyDictationTranscript(anchor: DictationAnchor, raw: string): string {
  const transcript = raw.replace(/\r\n/g, "\n").trim();
  if (!transcript) return `${anchor.prefix}${anchor.suffix}`;
  const lead =
    anchor.prefix.length > 0 && !/\s$/.test(anchor.prefix) && !/^[,.;:!?)]/.test(transcript)
      ? " "
      : "";
  const trail =
    anchor.suffix.length > 0 && !/^\s/.test(anchor.suffix) && !/^[,.;:!?)]/.test(anchor.suffix)
      ? " "
      : "";
  return `${anchor.prefix}${lead}${transcript}${trail}${anchor.suffix}`;
}

export function dictationErrorMessage(event: Pick<DictationEvent, "code" | "message">): string {
  if (event.code === "permission_denied")
    return "Allow microphone and speech recognition for Zoltbot in System Settings.";
  if (event.code === "recognizer_unavailable")
    return "Speech recognition isn't available for this language.";
  return event.message || "Dictation stopped. Try again.";
}

function bridge(): DictationDesktopApi | undefined {
  return (window.openbot as { dictation?: DictationDesktopApi } | undefined)?.dictation;
}

function cancelSession(id: string | undefined): void {
  if (id)
    void bridge()
      ?.cancel(id)
      .catch(() => undefined);
}

function granted(status: DictationStatus): boolean {
  return status.microphone === "authorized" && status.speech === "authorized";
}

function refused(status: DictationStatus): boolean {
  return [status.microphone, status.speech].some(
    (access) => access === "denied" || access === "restricted",
  );
}

export interface DictationOptions {
  /** Changing scope (another chat) cancels an active session. */
  scope: Accessor<string | undefined>;
  draft: Accessor<string>;
  onDraft: (text: string) => void;
  onError: (message: string | null) => void;
  /** O3: back to idle; `finished` when stop() ended it and its last words are in the draft. */
  onIdle?: (finished: boolean) => void;
}

/**
 * Voice dictation through the main-process speech helper. The helper records the microphone
 * itself, so the renderer only starts and stops sessions and writes transcripts into the draft.
 */
export function createDictation(options: DictationOptions) {
  const [available, setAvailable] = createSignal(false);
  const [phase, setPhase] = createSignal<DictationPhase>("idle");
  let status: DictationStatus | undefined;
  let sessionId: string | undefined;
  let anchor: DictationAnchor | undefined;
  // O3: let go while it was still starting; stop as soon as it listens.
  let stopWhenListening = false;

  const reset = (finished = false) => {
    stopWhenListening = false;
    sessionId = undefined;
    anchor = undefined;
    const was = phase();
    setPhase("idle");
    if (was !== "idle") options.onIdle?.(finished);
  };

  onMount(() => {
    const api = bridge();
    if (!api) return;
    void api
      .status()
      .then((next) => {
        status = next;
        setAvailable(next.available);
      })
      .catch(() => setAvailable(false));
    const unsubscribe = api.onEvent((event) => {
      if (!sessionId || event.sessionId !== sessionId) return;
      if (event.kind === "partial" || event.kind === "final") {
        if (phase() === "starting") setPhase("listening");
        if (anchor) options.onDraft(applyDictationTranscript(anchor, event.text ?? ""));
        return;
      }
      if (event.kind === "error") {
        options.onError(dictationErrorMessage(event));
        reset();
        return;
      }
      reset(phase() === "finishing");
    });
    onCleanup(unsubscribe);
  });

  const start = async () => {
    const api = bridge();
    if (!api || phase() !== "idle") return;
    options.onError(null);
    anchor = captureDictationAnchor(options.draft());
    setPhase("starting");
    try {
      if (!status || !granted(status)) {
        status = await api.requestPermission();
        if (phase() !== "starting") return;
        if (refused(status)) {
          options.onError(
            "Allow microphone and speech recognition for Zoltbot in System Settings.",
          );
          reset();
          return;
        }
      }
      const started = await api.start({ source: "microphone", locale: status.locale });
      if (phase() !== "starting") {
        cancelSession(started.sessionId);
        return;
      }
      sessionId = started.sessionId;
      setPhase("listening");
      if (stopWhenListening) void stop();
    } catch {
      options.onError("Couldn't start dictation. Try again.");
      reset();
    }
  };

  const stop = async () => {
    const api = bridge();
    const id = sessionId;
    if (phase() === "starting") stopWhenListening = true;
    if (!api || !id || phase() !== "listening") return;
    setPhase("finishing");
    try {
      await api.stop(id);
    } catch {
      reset();
    }
  };

  const cancel = () => {
    const id = sessionId;
    const restore = anchor?.initialDraft;
    if (phase() === "idle") return;
    reset();
    if (restore !== undefined) options.onDraft(restore);
    cancelSession(id);
  };

  const toggle = () => {
    if (phase() === "idle") void start();
    else if (phase() === "listening") void stop();
    else if (phase() === "starting") cancel();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || phase() === "idle") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  window.addEventListener("keydown", onKeyDown, true);
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    const id = sessionId;
    reset();
    cancelSession(id);
  });

  createEffect(
    on(
      options.scope,
      () => {
        const id = sessionId;
        if (phase() === "idle") return;
        reset();
        cancelSession(id);
      },
      { defer: true },
    ),
  );

  return { available, phase, active: () => phase() !== "idle", toggle, start, stop, cancel };
}

function MicIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <rect x="7.25" y="3" width="5.5" height="9" rx="2.75" stroke-width="1.3" />
      <path
        d="M4.75 9.5a5.25 5.25 0 0 0 10.5 0M10 14.75V17"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function DictationButton(props: {
  dictation: ReturnType<typeof createDictation>;
  disabled: boolean;
}) {
  const label = () => {
    const phase = props.dictation.phase();
    if (phase === "listening") return "Stop dictation";
    if (phase === "finishing") return "Finishing dictation";
    return "Dictate";
  };
  return (
    <button
      type="button"
      class="composer-button dictation-button"
      classList={{ "dictation-button-active": props.dictation.active() }}
      aria-label={label()}
      aria-pressed={props.dictation.active()}
      title={label()}
      disabled={props.disabled || props.dictation.phase() === "finishing"}
      onClick={() => props.dictation.toggle()}
    >
      <MicIcon />
    </button>
  );
}
