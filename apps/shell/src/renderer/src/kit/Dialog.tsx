import { children, createSignal, createUniqueId, type JSX, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { floatingLayer, useDismiss } from "./floating";

const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export interface DialogProps {
  /** Required. Names the dialog and is read first by screen readers. */
  title: string;
  /** Body content. Keep it to what the person needs to decide or act. */
  children?: JSX.Element;
  /** Buttons, right-aligned. Label each with a verb and its object, such as "Delete agent". */
  actions: JSX.Element;
  onClose: () => void;
  /** While true, Escape and a press outside don't close it. */
  busy?: boolean;
  /** "alertdialog" for confirmations that interrupt. */
  role?: "dialog" | "alertdialog";
  /** Selector of the element to focus first; defaults to the first focusable element. */
  initialFocus?: string;
  width?: number;
}

/** A modal dialog. Focus stays inside it and returns to where it was when it closes. */
export function Dialog(props: DialogProps) {
  const titleId = createUniqueId();
  const bodyId = createUniqueId();
  let panel: HTMLElement | undefined;
  // Resolve the body once: reading props.children again would build it again.
  const body = children(() => props.children);

  // Registered before focus moves in, so it remembers what had focus. Escape joins the same stack as menus, so it closes whichever overlay is newest.
  // A press outside is handled by the backdrop below.
  useDismiss({
    open: () => true,
    floating: () => panel,
    anchor: () => undefined,
    outside: false,
    onDismiss: () => {
      if (!props.busy) props.onClose();
    },
  });

  onMount(() => {
    const preferred = props.initialFocus
      ? panel?.querySelector<HTMLElement>(props.initialFocus)
      : null;
    (preferred ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();
  });

  const keydown = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !panel || event.defaultPrevented) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const inside = focusable.includes(document.activeElement as HTMLElement);
    if (event.shiftKey && (document.activeElement === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <Portal mount={floatingLayer()}>
      <div
        class="zb-kit-backdrop"
        role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget && !props.busy) props.onClose();
        }}
      >
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is dialog or alertdialog, both modal. */}
        <section
          ref={panel}
          class="zb-kit-dialog"
          role={props.role ?? "dialog"}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={body() ? bodyId : undefined}
          aria-busy={props.busy || undefined}
          data-kit-overlay="dialog"
          tabIndex={-1}
          style={props.width ? { width: `min(${props.width}px, calc(100vw - 32px))` } : undefined}
          onKeyDown={keydown}
        >
          <h2 id={titleId} class="zb-kit-dialog-title">
            {props.title}
          </h2>
          <Show when={body()}>
            <div id={bodyId} class="zb-kit-dialog-body">
              {body()}
            </div>
          </Show>
          <div class="zb-kit-dialog-actions">{props.actions}</div>
        </section>
      </div>
    </Portal>
  );
}

export interface ConfirmDialogProps {
  /** Names the action and its object, for example "Delete Ada?". */
  title: string;
  /** The consequence, in one or two sentences. */
  body: string;
  /** Verb and object, for example "Delete agent". */
  confirmLabel: string;
  /** Shown on the confirm button while the action runs, for example "Deleting…". */
  busyLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** What went wrong and what to do next. Turns the confirm button into "Try again". */
  error?: string | null;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  typedConfirmation?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before an action that can't be undone. Focus starts on Cancel. */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const [typed, setTyped] = createSignal("");
  const typedId = createUniqueId();
  const ready = () => !props.typedConfirmation || typed() === props.typedConfirmation;
  return (
    <Dialog
      title={props.title}
      role="alertdialog"
      busy={props.busy}
      onClose={props.onCancel}
      initialFocus=".zb-kit-cancel"
      width={400}
      actions={
        <>
          <button
            type="button"
            class="zb-kit-button zb-kit-cancel"
            disabled={props.busy}
            onClick={() => props.onCancel()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="zb-kit-button"
            classList={{ danger: props.danger, primary: !props.danger }}
            disabled={props.busy || !ready()}
            aria-busy={props.busy || undefined}
            onClick={() => props.onConfirm()}
          >
            <Show when={props.busy}>
              <span class="zb-kit-spinner" aria-hidden="true" />
            </Show>
            {props.busy
              ? (props.busyLabel ?? props.confirmLabel)
              : props.error
                ? "Try again"
                : props.confirmLabel}
          </button>
        </>
      }
    >
      <p>{props.body}</p>
      <Show when={props.typedConfirmation}>
        <label class="zb-kit-field-label" for={typedId}>
          Type “{props.typedConfirmation}” to confirm
        </label>
        <input
          id={typedId}
          class="zb-kit-input"
          value={typed()}
          autocomplete="off"
          spellcheck={false}
          onInput={(event) => setTyped(event.currentTarget.value)}
        />
      </Show>
      <Show when={props.error}>
        <p class="zb-kit-error" role="alert">
          {props.error}
        </p>
      </Show>
    </Dialog>
  );
}
