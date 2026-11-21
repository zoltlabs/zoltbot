// V3: pick a login from a password manager. The list shows titles and sites only; the password
// stays in the manager and is read by its own CLI when an agent signs in.
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { VaultProvider, VaultProviderItem } from "../../../../shared/vault";
import { t } from "../../i18n";
import { Dialog, Field } from "../../kit";

/** Commands are the same in every language. */
const UNLOCK = "bw unlock --raw";
const SIGN_IN: Record<VaultProvider["id"], string> = {
  "1password": "op signin",
  bitwarden: "bw login",
  proton: "pass-cli login",
};

export function ProviderDialog(props: {
  provider: VaultProvider;
  onClose: () => void;
  onPick: (item: VaultProviderItem) => void;
}) {
  const [provider, setProvider] = createSignal(props.provider);
  const [items, setItems] = createSignal<VaultProviderItem[] | null>(null);
  const [search, setSearch] = createSignal("");
  const [picked, setPicked] = createSignal<string | null>(null);
  const [session, setSession] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const name = () => provider().name;
  let searchInput: HTMLInputElement | undefined;

  async function load() {
    if (provider().state !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      setItems(await window.openbot.vault.providerItems({ provider: provider().id }));
      searchInput?.focus();
    } catch {
      setItems(null);
      setError(t("vault.provider.error"));
    } finally {
      setBusy(false);
    }
  }
  onMount(() => void load());

  async function unlock() {
    if (busy() || !session().trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.openbot.vault.providerUnlock({
        provider: provider().id,
        session: session(),
      });
      setSession("");
      setProvider(next);
      setBusy(false);
      if (next.state === "ready") await load();
      else setError(t("vault.provider.stillLocked", { name: name() }));
    } catch (failure) {
      // The service already turns the daemon's codes into words; anything else is generic.
      const message = failure instanceof Error ? failure.message : "";
      setError(message.startsWith("That key") ? message : t("vault.provider.unlockFailed"));
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      const next = await window.openbot.vault.providerForget(provider().id);
      setItems(null);
      setPicked(null);
      setProvider(next);
    } catch {
      setError(t("vault.provider.forgetFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const all = await window.openbot.vault.providers();
      const next = all.find((item) => item.id === provider().id);
      if (next) setProvider(next);
    } catch {
      setError(t("vault.provider.error"));
      setBusy(false);
      return;
    }
    setBusy(false);
    if (provider().state === "ready") await load();
    else if (provider().state === "signed_out")
      setError(t("vault.provider.stillSignedOut", { name: name() }));
    else if (provider().state === "failed") setError(t("vault.provider.error"));
  }

  const shown = () => {
    const query = search().trim().toLowerCase();
    return (items() ?? []).filter(
      (item) =>
        !query ||
        item.title.toLowerCase().includes(query) ||
        (item.username ?? "").toLowerCase().includes(query) ||
        item.sites.some((site) => site.toLowerCase().includes(query)),
    );
  };
  // A row hidden by the search can't be added.
  const chosen = () => shown().find((item) => item.id === picked());
  const next = () => {
    const item = chosen();
    if (item) props.onPick(item);
  };

  return (
    <Dialog
      title={t("vault.provider.title", { name: name() })}
      busy={busy()}
      onClose={props.onClose}
      width={440}
      actions={
        <>
          <Show when={error()}>
            {(message) => (
              <p class="zb-kit-error vault-form-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onClose}>
            {t("vault.cancel")}
          </button>
          <Switch>
            <Match when={provider().state === "ready" && error() && !items()}>
              <button
                type="button"
                class="zb-kit-button primary"
                disabled={busy()}
                onClick={() => void load()}
              >
                {t("vault.provider.retry")}
              </button>
            </Match>
            <Match when={provider().state === "ready"}>
              <button
                type="button"
                class="zb-kit-button primary"
                disabled={busy() || !chosen()}
                onClick={next}
              >
                {t("vault.provider.next")}
              </button>
            </Match>
            <Match when={provider().state === "locked"}>
              <button
                type="button"
                class="zb-kit-button primary"
                disabled={busy() || !session().trim()}
                aria-busy={busy() || undefined}
                onClick={() => void unlock()}
              >
                {t("vault.provider.unlock")}
              </button>
            </Match>
            <Match when={true}>
              <button
                type="button"
                class="zb-kit-button primary"
                disabled={busy()}
                onClick={() => void retry()}
              >
                {t("vault.provider.retry")}
              </button>
            </Match>
          </Switch>
        </>
      }
    >
      <Switch>
        <Match when={provider().state === "ready"}>
          <form
            class="vault-form"
            onSubmit={(event) => {
              event.preventDefault();
              next();
            }}
          >
            <Field
              label={t("vault.provider.search")}
              input={(id) => (
                <input
                  ref={searchInput}
                  id={id}
                  type="search"
                  class="zb-kit-input"
                  disabled={!items()}
                  autocomplete="off"
                  spellcheck={false}
                  value={search()}
                  onInput={(event) => setSearch(event.currentTarget.value)}
                />
              )}
            />
            <Show when={busy() && !items()}>
              <p class="vault-provider-note" role="status">
                {t("vault.provider.loading")}
              </p>
            </Show>
            <Show when={items()}>
              <Show
                when={shown().length}
                fallback={
                  <p class="vault-provider-note" role="status">
                    {items()?.length
                      ? t("vault.provider.none")
                      : t("vault.provider.empty", { name: name() })}
                  </p>
                }
              >
                <fieldset class="vault-provider-list">
                  <legend class="sr-only">{t("vault.provider.logins", { name: name() })}</legend>
                  <For each={shown()}>
                    {(item) => (
                      <label class="vault-provider-item">
                        <input
                          type="radio"
                          name="vault-provider-item"
                          checked={picked() === item.id}
                          onChange={() => setPicked(item.id)}
                        />
                        <span class="vault-copy">
                          <span class="vault-label">
                            {item.title || item.sites[0] || t("vault.provider.untitled")}
                          </span>
                          <Show when={[item.username, item.sites[0]].filter(Boolean).join(" · ")}>
                            {(meta) => <span class="vault-meta">{meta()}</span>}
                          </Show>
                        </span>
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
            </Show>
            <Show when={provider().path}>
              <button
                type="button"
                class="zb-kit-button vault-provider-forget"
                disabled={busy()}
                onClick={() => void forget()}
              >
                {t("vault.provider.forget")}
              </button>
            </Show>
            <button type="submit" hidden />
          </form>
        </Match>
        <Match when={provider().state === "locked"}>
          <form
            class="vault-form"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <p class="vault-provider-note">
              {t("vault.provider.lockedBody", { name: name() })}{" "}
              <code>{UNLOCK}</code>
            </p>
            <Show when={provider().path}>
              {(program) => (
                <p class="vault-provider-note">
                  {t("vault.provider.program")} <code>{program()}</code>
                </p>
              )}
            </Show>
            <Field
              label={t("vault.provider.session")}
              input={(id) => (
                <input
                  id={id}
                  type="password"
                  class="zb-kit-input"
                  autocomplete="off"
                  spellcheck={false}
                  value={session()}
                  onInput={(event) => setSession(event.currentTarget.value)}
                />
              )}
            />
            <button type="submit" hidden />
          </form>
        </Match>
        <Match when={provider().state === "signed_out"}>
          <p class="vault-provider-note">
            {t("vault.provider.signedOut", { name: name() })}{" "}
            <code>{SIGN_IN[provider().id]}</code>
          </p>
        </Match>
        <Match when={true}>
          <p class="vault-provider-note">{t("vault.provider.failed", { name: name() })}</p>
        </Match>
      </Switch>
    </Dialog>
  );
}
