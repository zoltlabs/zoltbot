// V1: add or edit a login or a two-step code. The value field is never filled from the list;
// Show asks the Mac for Touch ID or the password, then puts the stored value in the field.
import { parseTotpSetup, totpIssuer, vaultHost } from "@zoltbot/protocol";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { VaultItem, VaultItemKind } from "../../../../shared/vault";
import { t } from "../../i18n";
import { Dialog, Field } from "../../kit";
import { readQrPicture } from "./qr";

export interface VaultAgentOption {
  id: string;
  name: string;
}

export function VaultDialog(props: {
  kind: VaultItemKind;
  /** The entry being edited; absent when adding. */
  item?: VaultItem;
  agents: readonly VaultAgentOption[];
  onClose: () => void;
  onSaved: (item: VaultItem) => void;
}) {
  const editing = () => !!props.item;
  const login = () => props.kind === "login";
  const [site, setSite] = createSignal(props.item?.sites[0] ?? "");
  const [username, setUsername] = createSignal(props.item?.username ?? "");
  const [value, setValue] = createSignal("");
  const [shown, setShown] = createSignal(false);
  // Only a value the owner typed is sent; a shown value goes back unchanged.
  const [edited, setEdited] = createSignal(false);
  const [revealing, setRevealing] = createSignal(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hideTimer));
  const [all, setAll] = createSignal(props.item ? props.item.agents === "all" : true);
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(
    new Set(props.item && props.item.agents !== "all" ? props.item.agents : []),
  );
  const [busy, setBusy] = createSignal(false);
  const [errors, setErrors] = createSignal<{
    site?: string;
    value?: string;
    agents?: string;
    form?: string;
  }>({});

  const title = () =>
    t(
      login()
        ? editing()
          ? "vault.dialog.editLogin"
          : "vault.addLogin"
        : editing()
          ? "vault.dialog.editCode"
          : "vault.addCode",
    );

  function check(): boolean {
    const next: { site?: string; value?: string; agents?: string } = {};
    if (!vaultHost(site())) next.site = t("vault.error.site");
    if (!editing() && !edited())
      next.value = t(login() ? "vault.error.password" : "vault.error.key");
    if (!login() && edited() && !parseTotpSetup(value())) next.value = t("vault.error.key");
    if (!all() && !chosen().size) next.agents = t("vault.error.agents");
    setErrors(next);
    return !next.site && !next.value && !next.agents;
  }

  async function save() {
    if (busy() || !check()) return;
    setBusy(true);
    const agents = all() ? ("all" as const) : [...chosen()];
    try {
      const item = props.item
        ? await window.openbot.vault.update({
            id: props.item.id,
            site: site(),
            ...(login() ? { username: username() } : {}),
            agents,
            ...(edited() && value() ? { value: value() } : {}),
          })
        : await window.openbot.vault.save({
            kind: props.kind,
            site: site(),
            ...(login() ? { username: username() } : {}),
            agents,
            value: value(),
          });
      props.onSaved(item);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : t("vault.error.save") });
      setBusy(false);
    }
  }

  async function reveal() {
    const id = props.item?.id;
    if (!id || revealing()) return;
    setRevealing(true);
    try {
      setValue(await window.openbot.vault.reveal(id));
      setEdited(false);
      setShown(true);
      // A shown value doesn't stay on screen.
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (edited()) return;
        setValue("");
        setShown(false);
      }, 30_000);
    } catch {
      // Cancelling the Mac's prompt leaves the field as it was.
    } finally {
      setRevealing(false);
    }
  }

  async function chooseQr(file: File | undefined) {
    if (!file) return;
    const text = await readQrPicture(file);
    if (!text || !parseTotpSetup(text)) {
      setErrors((current) => ({ ...current, value: t("vault.error.qr") }));
      return;
    }
    setValue(text);
    setEdited(true);
    const issuer = totpIssuer(text);
    if (!site() && issuer && vaultHost(issuer)) setSite(issuer);
    setErrors((current) => ({ ...current, value: undefined }));
  }

  return (
    <Dialog
      title={title()}
      busy={busy()}
      onClose={props.onClose}
      width={420}
      actions={
        <>
          <Show when={errors().form}>
            {(message) => (
              <p class="zb-kit-error vault-form-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <button type="button" class="zb-kit-button" disabled={busy()} onClick={props.onClose}>
            {t("vault.cancel")}
          </button>
          <button
            type="button"
            class="zb-kit-button primary"
            disabled={busy()}
            aria-busy={busy() || undefined}
            onClick={() => void save()}
          >
            {t(login() ? "vault.saveLogin" : "vault.saveCode")}
          </button>
        </>
      }
    >
      <form
        class="vault-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field
          label={t("vault.field.site")}
          error={errors().site}
          input={(id, describedBy) => (
            <input
              id={id}
              class="zb-kit-input"
              aria-describedby={describedBy}
              aria-invalid={!!errors().site || undefined}
              autocomplete="off"
              spellcheck={false}
              placeholder={t("vault.placeholder.site")}
              value={site()}
              onInput={(event) => setSite(event.currentTarget.value)}
            />
          )}
        />
        <Show when={login()}>
          <Field
            label={t("vault.field.username")}
            input={(id) => (
              <input
                id={id}
                class="zb-kit-input"
                autocomplete="off"
                spellcheck={false}
                value={username()}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            )}
          />
        </Show>
        <Field
          label={t(login() ? "vault.field.password" : "vault.field.key")}
          error={errors().value}
          input={(id, describedBy) => (
            <div class="vault-value-row">
              <input
                id={id}
                class="zb-kit-input"
                type={login() && !shown() ? "password" : "text"}
                aria-describedby={describedBy}
                aria-invalid={!!errors().value || undefined}
                autocomplete="new-password"
                spellcheck={false}
                placeholder={editing() ? "••••••••" : undefined}
                value={value()}
                onInput={(event) => {
                  setValue(event.currentTarget.value);
                  setEdited(true);
                }}
              />
              <Show when={editing()}>
                <button
                  type="button"
                  class="zb-kit-button"
                  disabled={revealing()}
                  onClick={() => void reveal()}
                >
                  {t("vault.show")}
                </button>
              </Show>
              <Show when={!login()}>
                <label class="zb-kit-button vault-qr">
                  {t("vault.chooseQr")}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    class="sr-only"
                    onChange={(event) => void chooseQr(event.currentTarget.files?.[0])}
                  />
                </label>
              </Show>
            </div>
          )}
        />
        <fieldset class="vault-agents">
          <legend class="zb-kit-field-label">{t("vault.field.agents")}</legend>
          <label class="vault-check">
            <input
              type="checkbox"
              checked={all()}
              onChange={(event) => setAll(event.currentTarget.checked)}
            />
            {t("vault.allAgents")}
          </label>
          <Show when={!all()}>
            <For each={props.agents}>
              {(agent) => (
                <label class="vault-check">
                  <input
                    type="checkbox"
                    checked={chosen().has(agent.id)}
                    onChange={(event) => {
                      const next = new Set(chosen());
                      if (event.currentTarget.checked) next.add(agent.id);
                      else next.delete(agent.id);
                      setChosen(next);
                    }}
                  />
                  {agent.name}
                </label>
              )}
            </For>
          </Show>
          <Show when={errors().agents}>
            {(message) => (
              <p class="zb-kit-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
