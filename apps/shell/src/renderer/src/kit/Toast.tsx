import { createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { floatingLayer } from "./floating";

export interface ToastInput {
  message: string;
  /** One follow-up, such as Undo or Try again. */
  action?: { label: string; run: () => void };
  /** Milliseconds before it hides. Toasts with an action stay longer by default. */
  duration?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
}

interface ToastTimer {
  handle?: ReturnType<typeof setTimeout>;
  remaining: number;
  startedAt: number;
}

const MAX_TOASTS = 3;
const [toasts, setToasts] = createSignal<ToastEntry[]>([]);
const timers = new Map<number, ToastTimer>();
let paused = false;
let nextId = 1;

function startTimer(id: number, timer: ToastTimer): void {
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

/** Shows a short status message. Returns a function that hides it early. */
export function showToast(input: ToastInput): () => void {
  const id = nextId++;
  const current = toasts();
  for (const old of current.slice(0, Math.max(0, current.length - (MAX_TOASTS - 1))))
    dismissToast(old.id);
  setToasts((list) => [...list, { ...input, id }]);
  const timer: ToastTimer = {
    remaining: input.duration ?? (input.action ? 8000 : 4000),
    startedAt: 0,
  };
  timers.set(id, timer);
  if (!paused) startTimer(id, timer);
  return () => dismissToast(id);
}

export function dismissToast(id: number): void {
  clearTimeout(timers.get(id)?.handle);
  timers.delete(id);
  setToasts((current) => current.filter((toast) => toast.id !== id));
}

/** Holds every toast on screen while the pointer or focus is on them. */
function setPaused(value: boolean): void {
  if (paused === value) return;
  paused = value;
  for (const [id, timer] of timers) {
    if (value) {
      clearTimeout(timer.handle);
      timer.handle = undefined;
      timer.remaining = Math.max(1000, timer.remaining - (Date.now() - timer.startedAt));
    } else startTimer(id, timer);
  }
}

/** Mount once near the app root. Announces toasts politely to screen readers. */
export function ToastRegion() {
  return (
    <Portal mount={floatingLayer()}>
      <section
        class="zb-kit-toasts"
        aria-label="Notifications"
        aria-live="polite"
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={(event) => setPaused(event.currentTarget.contains(document.activeElement))}
        onFocusIn={() => setPaused(true)}
        onFocusOut={(event) =>
          setPaused(event.currentTarget.contains(event.relatedTarget as Node | null))
        }
      >
        <For each={toasts()}>
          {(toast) => (
            <div class="zb-kit-toast" role="status">
              <span>{toast.message}</span>
              <Show when={toast.action}>
                {(action) => (
                  <button
                    type="button"
                    class="zb-kit-toast-action"
                    onClick={() => {
                      dismissToast(toast.id);
                      action().run();
                    }}
                  >
                    {action().label}
                  </button>
                )}
              </Show>
            </div>
          )}
        </For>
      </section>
    </Portal>
  );
}
