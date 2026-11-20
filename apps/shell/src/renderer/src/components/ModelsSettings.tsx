import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  type BackupEntryView,
  type BackupRole,
  type ModelAccountView,
  type ModelSignIn,
  type ModelsOverview,
  RUNNING_LIMIT,
} from "../../../shared/models";
import { Select } from "../kit";
import { SidebarToggleIcon } from "./Sidebar";

const ROLES: { id: BackupRole; label: string; title: string }[] = [
  { id: "employee", label: "Employees", title: "Backup order for employees" },
  { id: "manager", label: "Managers", title: "Backup order for managers" },
  { id: "ceo", label: "CEO", title: "Backup order for the CEO" },
];

const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function message(error: unknown, fallback: string): string {
  const text = error instanceof Error ? error.message : "";
  if (text.includes("provider_login_unavailable") || text.includes("login_command_unavailable"))
    return "This coding tool can't sign in from Zoltbot. Check that it's installed.";
  return fallback;
}

function accountStatus(account: ModelAccountView): string {
  const login =
    account.login === "signed_in"
      ? "Signed in"
      : account.login === "signed_out"
        ? "Signed out"
        : "Sign-in not checked";
  return account.limitResetsAt
    ? `${login} · limit resets ${timeOfDay(account.limitResetsAt)}`
    : login;
}

/** Accounts for each coding tool and the order chats fall back through at usage limits. */
export function ModelsSettings(props: { sidebarCollapsed: boolean; onShowSidebar: () => void }) {
  const models = window.openbot.models;
  const [overview, setOverview] = createSignal<ModelsOverview | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [tool, setTool] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [signIn, setSignIn] = createSignal<{ account: string; info: ModelSignIn } | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [removing, setRemoving] = createSignal("");
  const [role, setRole] = createSignal<BackupRole>("employee");
  const [candidate, setCandidate] = createSignal("");
  const [limit, setLimit] = createSignal<number | null>(null);
  const [limitDraft, setLimitDraft] = createSignal("");
  const draftLimit = () => Number(limitDraft());
  const limitValid = () =>
    /^\d+$/.test(limitDraft().trim()) &&
    draftLimit() >= RUNNING_LIMIT.min &&
    draftLimit() <= RUNNING_LIMIT.max;

  const accounts = () => overview()?.accounts ?? [];
  const tools = createMemo(() =>
    accounts().filter((account) => account.isDefault && account.canAddAccounts),
  );
  const singleSignIn = () =>
    accounts().some((account) => account.isDefault && !account.canAddAccounts);
  const byId = (id: string) => accounts().find((account) => account.id === id);
  const own = () => (role() === "employee" ? null : (overview()?.orders[role()] ?? null));
  const order = (): BackupEntryView[] => own() ?? overview()?.orders.employee ?? [];
  const shared = () => role() !== "employee" && own() === null;
  const unlisted = () =>
    accounts().filter((account) => !order().some((entry) => entry.accountId === account.id));

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      setOverview(await models.read());
    } catch (caught) {
      setError(message(caught, fallback));
    } finally {
      setBusy(false);
    }
  }
  onMount(() => void run(async () => undefined, "Accounts couldn't load. Try again."));
  onMount(() => {
    void models
      .runningLimit()
      .then((value) => {
        setLimit(value);
        setLimitDraft(String(value));
      })
      .catch(() => setError("The task limit couldn't load. Try again."));
  });

  function saveLimit(event: SubmitEvent) {
    event.preventDefault();
    if (!limitValid()) return;
    const next = draftLimit();
    void run(
      async () => setLimit(await models.setRunningLimit(next)),
      "The limit couldn't be saved.",
    );
  }

  const saveOrder = (entries: BackupEntryView[] | null) =>
    run(() => models.setOrder({ role: role(), entries }), "The order couldn't be saved.");
  const move = (index: number, by: number) => {
    const next = [...order()];
    const [entry] = next.splice(index, 1);
    if (!entry) return;
    next.splice(index + by, 0, entry);
    void saveOrder(next);
  };

  async function addAccount(event: SubmitEvent) {
    event.preventDefault();
    const definitionId = tool() || tools()[0]?.definitionId;
    if (!definitionId || !label().trim()) return;
    await run(async () => {
      const result = await models.addAccount({ definitionId, label: label().trim() });
      setSignIn({ account: result.account.name, info: result.signIn });
      setCopied(false);
      setAdding(false);
      setLabel("");
    }, "The account couldn't be added.");
  }

  const showSignIn = (account: ModelAccountView) =>
    run(async () => {
      setSignIn({ account: account.name, info: await models.signIn(account.id) });
      setCopied(false);
    }, "The sign-in command isn't available.");

  return (
    <main aria-label="Models" class="map-panel">
      <header class="window-drag map-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title="Show sidebar"
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 class="map-title">Models</h1>
      </header>
      <div class="models-body">
        <Show when={error()}>
          <p class="models-error" role="alert">
            {error()}
          </p>
        </Show>
        <section class="models-section" aria-labelledby="models-accounts">
          <h2 id="models-accounts" class="models-heading">
            Accounts
          </h2>
          <ul class="models-list">
            <For each={accounts()}>
              {(account) => (
                <li class="models-row">
                  <div class="models-row-copy">
                    <strong>{account.name}</strong>
                    <span>{accountStatus(account)}</span>
                  </div>
                  <span
                    class="models-pill"
                    classList={{
                      "models-pill-limit": account.atLimit,
                      "models-pill-use": !account.atLimit && account.inUse > 0,
                      "models-pill-ready":
                        !account.atLimit && account.inUse === 0 && account.login === "signed_in",
                    }}
                  >
                    {account.atLimit ? "At limit" : account.inUse > 0 ? "In use" : "Ready"}
                  </span>
                  <div class="models-row-actions">
                    <Show
                      when={removing() === account.id}
                      fallback={
                        <>
                          <button
                            type="button"
                            class="models-link"
                            disabled={busy()}
                            onClick={() => void showSignIn(account)}
                          >
                            Sign in
                          </button>
                          <button
                            type="button"
                            class="models-link"
                            disabled={busy()}
                            onClick={() =>
                              void run(
                                () => models.check(account.id),
                                "The sign-in couldn't be checked.",
                              )
                            }
                          >
                            Check
                          </button>
                          <Show when={!account.isDefault}>
                            <button
                              type="button"
                              class="models-link"
                              disabled={busy()}
                              onClick={() => setRemoving(account.id)}
                            >
                              Remove
                            </button>
                          </Show>
                        </>
                      }
                    >
                      <button
                        type="button"
                        class="models-link"
                        disabled={busy()}
                        onClick={() => setRemoving("")}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="models-link models-link-danger"
                        disabled={busy()}
                        onClick={() =>
                          void run(async () => {
                            await models.remove(account.id);
                            setRemoving("");
                          }, "The account couldn't be removed.")
                        }
                      >
                        Remove {account.name}
                      </button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
          <Show when={overview() && !accounts().length}>
            <p class="models-empty">No coding tools are set up yet. Add an agent first.</p>
          </Show>
          <Show when={signIn()}>
            {(current) => (
              <div class="models-signin">
                <p>Run this in Terminal to sign in to {current().account}:</p>
                <code class="models-command">{current().info.command}</code>
                <Show when={current().info.slashCommand}>
                  {(typed) => (
                    <p>
                      Then type <code>{typed()}</code>.
                    </p>
                  )}
                </Show>
                <div class="models-actions">
                  <button
                    type="button"
                    class="models-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(current().info.command);
                        setCopied(true);
                      } catch {
                        setError("Couldn't copy. Select the command to copy it.");
                      }
                    }}
                  >
                    {copied() ? "Copied" : "Copy command"}
                  </button>
                  <button type="button" class="models-button" onClick={() => setSignIn(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}
          </Show>
          <Show
            when={adding()}
            fallback={
              <Show when={tools().length}>
                <button
                  type="button"
                  class="models-button"
                  disabled={busy()}
                  onClick={() => setAdding(true)}
                >
                  Add account
                </button>
              </Show>
            }
          >
            <form class="models-form" onSubmit={(event) => void addAccount(event)}>
              <div class="models-field">
                <span aria-hidden="true">Tool</span>
                <Select
                  label="Tool"
                  value={tool()}
                  describedBy={singleSignIn() ? "models-tool-note" : undefined}
                  options={tools().map((item) => ({
                    value: item.definitionId,
                    label: item.providerName,
                  }))}
                  onChange={setTool}
                />
              </div>
              <label class="models-field">
                <span>Name</span>
                <input
                  value={label()}
                  maxLength={80}
                  placeholder="Work"
                  onInput={(event) => setLabel(event.currentTarget.value)}
                />
              </label>
              <div class="models-actions">
                <button type="button" class="models-button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="models-button models-button-primary"
                  disabled={busy() || !label().trim()}
                >
                  Add
                </button>
              </div>
              <Show when={singleSignIn()}>
                <p id="models-tool-note" class="models-form-note">
                  Other tools use only their own sign-in.
                </p>
              </Show>
            </form>
          </Show>
        </section>

        <section class="models-section" aria-labelledby="models-order">
          <h2 id="models-order" class="models-heading">
            {ROLES.find((item) => item.id === role())?.title}
          </h2>
          <p class="models-consequence">
            When one hits its limit, the next takes over until it resets.
          </p>
          <fieldset class="models-roles">
            <legend class="sr-only">Role</legend>
            <For each={ROLES}>
              {(item) => (
                <label class="models-role" classList={{ "models-role-active": role() === item.id }}>
                  <input
                    type="radio"
                    name="models-role"
                    class="sr-only"
                    checked={role() === item.id}
                    onChange={() => setRole(item.id)}
                  />
                  <span>{item.label}</span>
                  <Show when={item.id !== "employee"}>
                    <span class="models-role-state">
                      {overview()?.orders[item.id] ? "own order" : "same as employees"}
                    </span>
                  </Show>
                </label>
              )}
            </For>
          </fieldset>
          <Show
            when={!shared()}
            fallback={
              <div class="models-actions">
                <button
                  type="button"
                  class="models-button"
                  disabled={busy()}
                  onClick={() => void saveOrder([...(overview()?.orders.employee ?? [])])}
                >
                  Use own order
                </button>
              </div>
            }
          >
            <ol class="models-list">
              <For each={order()}>
                {(entry, index) => {
                  const account = () => byId(entry.accountId);
                  const other = () =>
                    index() > 0 &&
                    account()?.definitionId !== byId(order()[0]?.accountId ?? "")?.definitionId;
                  return (
                    <li class="models-row">
                      <span class="models-index">{index() + 1}</span>
                      <div class="models-row-copy">
                        <strong>{account()?.name ?? "Removed account"}</strong>
                        <span>
                          {entry.model ?? "Default model"}
                          {other() ? " · another provider" : ""}
                        </span>
                      </div>
                      <div class="models-row-actions">
                        <button
                          type="button"
                          class="models-link"
                          disabled={busy() || index() === 0}
                          aria-label={`Move ${account()?.name ?? "entry"} up`}
                          onClick={() => move(index(), -1)}
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          class="models-link"
                          disabled={busy() || index() === order().length - 1}
                          aria-label={`Move ${account()?.name ?? "entry"} down`}
                          onClick={() => move(index(), 1)}
                        >
                          Down
                        </button>
                        <button
                          type="button"
                          class="models-link"
                          disabled={busy()}
                          aria-label={`Remove ${account()?.name ?? "entry"} from the order`}
                          onClick={() => void saveOrder(order().filter((_, at) => at !== index()))}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ol>
            <Show when={!order().length}>
              <p class="models-empty">No backups. Chats wait when their account hits its limit.</p>
            </Show>
            <div class="models-actions">
              <Show when={unlisted().length && order().length < 8}>
                <Select
                  label="Account to add"
                  value={candidate() || null}
                  placeholder="Choose an account"
                  options={unlisted().map((item) => ({ value: item.id, label: item.name }))}
                  onChange={setCandidate}
                />
                <button
                  type="button"
                  class="models-button"
                  disabled={busy() || !candidate()}
                  onClick={() => {
                    const accountId = candidate();
                    setCandidate("");
                    void saveOrder([...order(), { accountId }]);
                  }}
                >
                  Add to order
                </button>
              </Show>
              <Show when={role() !== "employee"}>
                <button
                  type="button"
                  class="models-button"
                  disabled={busy()}
                  onClick={() => void saveOrder(null)}
                >
                  Use employees' order
                </button>
              </Show>
            </div>
          </Show>
        </section>

        <section class="models-section" aria-labelledby="models-limit">
          <h2 id="models-limit" class="models-heading">
            Parallel tasks
          </h2>
          <form class="models-form" onSubmit={saveLimit}>
            <label class="models-field">
              <span>Tasks each employee runs at once</span>
              <input
                type="number"
                class="models-limit-input"
                inputmode="numeric"
                min={RUNNING_LIMIT.min}
                max={RUNNING_LIMIT.max}
                step="1"
                value={limitDraft()}
                disabled={limit() === null}
                aria-invalid={limitDraft() !== "" && !limitValid()}
                aria-describedby={limitValid() ? undefined : "models-limit-error"}
                onInput={(event) => setLimitDraft(event.currentTarget.value)}
              />
            </label>
            <div class="models-actions">
              <button
                type="submit"
                class="models-button models-button-primary"
                disabled={busy() || !limitValid() || draftLimit() === limit()}
              >
                Save
              </button>
            </div>
            <Show when={limit() !== null && !limitValid()}>
              <p id="models-limit-error" class="models-error models-field-error">
                Enter a whole number from {RUNNING_LIMIT.min} to {RUNNING_LIMIT.max}.
              </p>
            </Show>
          </form>
        </section>
      </div>
    </main>
  );
}
