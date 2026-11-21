// V4: a message that looks like it holds a password or key waits above the composer. Save to
// vault keeps the secret in the keychain and puts a reference like "[vault: API key]" in the
// message instead; Send anyway sends it as written.
import { findSecret, type SecretMatch } from "@zoltbot/protocol";
import { createSignal, createUniqueId, Show } from "solid-js";
import { type MessageKey, t } from "../../i18n";
import "./secret-bar.css";

const NAMES: Record<SecretMatch["kind"], MessageKey> = {
  api_key: "secret.kind.apiKey",
  token: "secret.kind.token",
  password: "secret.kind.password",
  private_key: "secret.kind.privateKey",
};

/** Holds a send while its text looks like a secret, until the owner saves or sends it. */
export function createSecretCheck() {
  const [held, setHeld] = createSignal<{ text: string; match: SecretMatch } | null>(null);
  let allowed: string | null = null;
  return {
    held,
    /** True when the send should wait for the owner. */
    hold(text: string) {
      if (allowed === text) {
        allowed = null;
        return false;
      }
      const match = findSecret(text);
      setHeld(match ? { text, match } : null);
      return !!match;
    },
    /** Send anyway: the next send of the same text goes through. */
    allow() {
      allowed = held()?.text ?? null;
      setHeld(null);
    },
    clear: () => setHeld(null),
  };
}

export function SecretBar(props: {
  text: string;
  match: SecretMatch;
  onReplace: (text: string) => void;
  onSendAnyway: () => void;
  /** Escape: closes the bar and keeps the draft as it is. */
  onCancel: () => void;
}) {
  const titleId = createUniqueId();
  const nameId = createUniqueId();
  let nameInput: HTMLInputElement | undefined;
  const [name, setName] = createSignal(t(NAMES[props.match.kind]));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function save() {
    if (busy() || !name().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { start, end } = props.match;
      const { reference } = await window.openbot.vault.saveSecret({
        label: name().trim(),
        value: props.text.slice(start, end),
      });
      props.onReplace(props.text.slice(0, start) + reference + props.text.slice(end));
    } catch {
      setError(t("secret.failed"));
      nameInput?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      class="secret-bar"
      aria-labelledby={titleId}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onCancel();
      }}
    >
      <p id={titleId} class="secret-bar-title">
        {t("secret.title")}
      </p>
      <label class="secret-bar-label" for={nameId}>
        {t("secret.name")}
      </label>
      <input
        ref={(element) => {
          nameInput = element;
          queueMicrotask(() => element.focus());
        }}
        id={nameId}
        class="zb-kit-input secret-bar-name"
        maxLength={80}
        autocomplete="off"
        spellcheck={false}
        value={name()}
        onInput={(event) => {
          setName(event.currentTarget.value);
          setError(null);
        }}
      />
      <button
        type="submit"
        class="zb-kit-button primary"
        // Disabling the focused button would drop focus; save() ignores a second press.
        aria-disabled={busy() || !name().trim() || undefined}
        aria-busy={busy() || undefined}
      >
        {t("secret.save")}
      </button>
      <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onSendAnyway}>
        {t("secret.send")}
      </button>
      <Show when={error()}>
        {(message) => (
          <p class="secret-bar-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </form>
  );
}
