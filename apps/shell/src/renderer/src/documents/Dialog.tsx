import { createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";

interface DialogProps {
  title: string;
  /** Read when the dialog's purpose needs one more sentence, such as what an action discards. */
  description?: string;
  onClose: () => void;
  children: JSX.Element;
  class?: string;
}

/**
 * A modal dialog. The browser keeps focus inside it and Escape closes it; when it closes, focus
 * goes back to whatever had it before.
 */
export function Dialog(props: DialogProps) {
  let dialog: HTMLDialogElement | undefined;
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const opener = document.activeElement as HTMLElement | null;

  onMount(() => {
    if (typeof dialog?.showModal === "function") dialog.showModal();
    else dialog?.setAttribute("open", "");
    const first = dialog?.querySelector<HTMLElement>(
      "[autofocus], input, textarea, select, button",
    );
    first?.focus();
  });
  onCleanup(() => {
    if (opener?.isConnected) requestAnimationFrame(() => opener.focus());
  });

  return (
    <dialog
      ref={dialog}
      class={`doc-dialog ${props.class ?? ""}`}
      aria-labelledby={titleId}
      aria-describedby={props.description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
    >
      <h2 id={titleId} class="doc-dialog-title">
        {props.title}
      </h2>
      <Show when={props.description}>
        <p id={descriptionId} class="doc-dialog-description">
          {props.description}
        </p>
      </Show>
      {props.children}
    </dialog>
  );
}

/** Asks before an action that discards text. */
export function ConfirmDialog(props: {
  title: string;
  description: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog title={props.title} description={props.description} onClose={props.onClose}>
      <div class="doc-dialog-actions">
        <button type="button" class="doc-button" autofocus onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="doc-button doc-button-danger"
          onClick={() => {
            props.onConfirm();
            props.onClose();
          }}
        >
          {props.confirm}
        </button>
      </div>
    </Dialog>
  );
}
