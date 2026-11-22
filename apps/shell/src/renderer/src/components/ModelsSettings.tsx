import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  type BackupEntryView,
  type BackupRole,
  type ModelAccountView,
  type ModelSignIn,
  type ModelsOverview,
  missingFreeModels,
  RUNNING_LIMIT,
} from "../../../shared/models";
import { AgentLogo, ConfirmDialog, Menu, Select } from "../kit";
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

type AccountTone = "ready" | "use" | "limit" | "out" | "unknown";

/** One status per account: the state that decides whether a chat can run on it now. */
function accountStatus(
  account: ModelAccountView,
  checking: boolean,
): { text: string; tone: AccountTone } {
  if (checking) return { text: "Checking…", tone: "unknown" };
  if (account.atLimit)
    return {
      text: account.limitResetsAt
        ? `At limit · resets ${timeOfDay(account.limitResetsAt)}`
        : "At limit",
      tone: "limit",
    };
  if (account.login === "signed_out") return { text: "Signed out", tone: "out" };
  if (account.inUse > 0)
    return {
      text: `In use · ${account.inUse} ${account.inUse === 1 ? "chat" : "chats"}`,
      tone: "use",
    };
  if (account.login === "signed_in") return { text: "Ready", tone: "ready" };
  return { text: "Not checked", tone: "unknown" };
}

const listNames = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");

/** Accounts for each coding tool and the order chats fall back through at usage limits. */
export function ModelsSettings(props: { sidebarCollapsed: boolean; onShowSidebar: () => void }) {
  const models = window.openbot.models;
  const [overview, setOverview] = createSignal<ModelsOverview | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [tool, setTool] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [signIn, setSignIn] = createSignal<{ accountId: string; info: ModelSignIn } | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [removing, setRemoving] = createSignal<ModelAccountView | null>(null);
  const [removeError, setRemoveError] = createSignal<string | null>(null);
  const [checking, setChecking] = createSignal<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = createSignal<{ account: ModelAccountView; anchor: Element } | null>(null);
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
  const chosenTool = () => tool() || tools()[0]?.definitionId || "";
  const singleSignIn = () =>
    accounts()
      .filter((account) => account.isDefault && !account.canAddAccounts)
      .map((account) => account.providerName);
  const byId = (id: string) => accounts().find((account) => account.id === id);
  const own = () => (role() === "employee" ? null : (overview()?.orders[role()] ?? null));
  const order = (): BackupEntryView[] => own() ?? overview()?.orders.employee ?? [];
  const shared = () => role() !== "employee" && own() === null;
  const freeToAdd = () => missingFreeModels(order(), overview()?.free ?? []);
  const freeName = (entry: BackupEntryView) =>
    overview()?.free.find((f) => f.accountId === entry.accountId && f.model === entry.model)?.name;
  const unlisted = () =>
    accounts().filter(
      (account) => !order().some((entry) => entry.accountId === account.id && !entry.model),
    );

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
  /** Checks sign-ins in parallel; each row shows "Checking…" until its own check returns. */
  async function check(ids: string[]) {
    if (!ids.length) return;
    setChecking((current) => new Set([...current, ...ids]));
    const results = await Promise.allSettled(ids.map((id) => models.check(id)));
    setChecking((current) => new Set([...current].filter((id) => !ids.includes(id))));
    if (results.some((result) => result.status === "rejected"))
      setError("A sign-in couldn't be checked. Try again from its menu.");
    try {
      setOverview(await models.read());
    } catch {
      setError("Accounts couldn't load. Try again.");
    }
  }
  onMount(async () => {
    await run(async () => undefined, "Accounts couldn't load. Try again.");
    await check(
      accounts()
        .filter((account) => account.login === "unknown")
        .map((a) => a.id),
    );
  });
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
    const definitionId = chosenTool();
    if (!definitionId || !label().trim()) return;
    await run(async () => {
      const result = await models.addAccount({ definitionId, label: label().trim() });
      setSignIn({ accountId: result.account.id, info: result.signIn });
      setCopied(false);
      setAdding(false);
      setLabel("");
    }, "The account couldn't be added.");
  }

  const showSignIn = (account: ModelAccountView) =>
    run(async () => {
      setSignIn({ accountId: account.id, info: await models.signIn(account.id) });
      setCopied(false);
    }, "The sign-in command isn't available.");

  async function removeAccount() {
    const account = removing();
    if (!account) return;
    setBusy(true);
    setRemoveError(null);
    try {
      await models.remove(account.id);
      if (signIn()?.accountId === account.id) setSignIn(null);
      setRemoving(null);
      setOverview(await models.read());
    } catch (caught) {
      setRemoveError(message(caught, "The account couldn't be removed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const menuGroups = (account: ModelAccountView) => [
    [
      {
        id: "check",
        label: "Check sign-in",
        disabled: checking().has(account.id),
        run: () => void check([account.id]),
      },
      ...(account.login === "signed_out"
        ? []
        : [{ id: "sign-in", label: "Sign in again", run: () => void showSignIn(account) }]),
    ],
    account.isDefault
      ? []
      : [
          {
            id: "remove",
            label: "Remove…",
            danger: true,
            run: () => {
              setRemoveError(null);
              setRemoving(account);
            },
          },
        ],
  ];

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
          <Show when={overview() && !accounts().length}>
            <p class="models-empty">No coding tools are set up yet. Add an agent first.</p>
          </Show>
          <ul class="models-list">
            <For each={accounts()}>
              {(account) => {
                const status = () => accountStatus(account, checking().has(account.id));
                const current = () =>
                  signIn()?.accountId === account.id ? signIn()?.info : undefined;
                return (
                  <li class="models-account">
                    <div class="models-account-row">
                      <span class="models-account-logo">
                        <AgentLogo
                          agent={{ id: account.definitionId, name: account.providerName }}
                          size={18}
                        />
                      </span>
                      <div class="models-row-copy">
                        <strong>{account.name}</strong>
                        <span class="models-status" data-tone={status().tone}>
                          <span class="models-status-dot" aria-hidden="true" />
                          {status().text}
                        </span>
                      </div>
                      <Show when={account.login === "signed_out" && !current()}>
                        <button
                          type="button"
                          class="models-button models-button-small"
                          disabled={busy()}
                          onClick={() => void showSignIn(account)}
                        >
                          Sign in
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="models-icon-button"
                        aria-label={`${account.name} options`}
                        aria-haspopup="menu"
                        aria-expanded={menu()?.account.id === account.id}
                        onClick={(event) =>
                          setMenu(
                            menu()?.account.id === account.id
                              ? null
                              : { account, anchor: event.currentTarget },
                          )
                        }
                      >
                        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                          <circle cx="3.5" cy="8" r="1.25" />
                          <circle cx="8" cy="8" r="1.25" />
                          <circle cx="12.5" cy="8" r="1.25" />
                        </svg>
                      </button>
                    </div>
                    <Show when={current()}>
                      {(info) => (
                        <div class="models-signin">
                          <p>Run this in Terminal to sign in:</p>
                          <div class="models-command-row">
                            <code class="models-command">{info().command}</code>
                            <button
                              type="button"
                              class="models-button models-button-small"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(info().command);
                                  setCopied(true);
                                } catch {
                                  setError("Couldn't copy. Select the command to copy it.");
                                }
                              }}
                            >
                              {copied() ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <Show when={info().slashCommand}>
                            {(typed) => (
                              <p>
                                Then type <code>{typed()}</code>.
                              </p>
                            )}
                          </Show>
                          <div class="models-actions">
                            <button
                              type="button"
                              class="models-button models-button-small"
                              onClick={() => {
                                setSignIn(null);
                                void check([account.id]);
                              }}
                            >
                              Done
                            </button>
                          </div>
                        </div>
                      )}
                    </Show>
                  </li>
                );
              }}
            </For>
            <Show when={tools().length}>
              <li class="models-account">
                <Show
                  when={adding()}
                  fallback={
                    <button
                      type="button"
                      class="models-account-row models-add-row"
                      disabled={busy()}
                      onClick={() => setAdding(true)}
                    >
                      <span class="models-account-logo models-add-logo" aria-hidden="true">
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <path d="M8 3v10M3 8h10" />
                        </svg>
                      </span>
                      Add account
                    </button>
                  }
                >
                  <form class="models-form" onSubmit={(event) => void addAccount(event)}>
                    <div class="models-field">
                      <span aria-hidden="true">Tool</span>
                      <Select
                        label="Tool"
                        value={chosenTool()}
                        describedBy={singleSignIn().length ? "models-tool-note" : undefined}
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
                    <Show when={singleSignIn().length}>
                      <p id="models-tool-note" class="models-form-note">
                        {listNames(singleSignIn())} {singleSignIn().length > 1 ? "allow" : "allows"}{" "}
                        only one account.
                      </p>
                    </Show>
                  </form>
                </Show>
              </li>
            </Show>
          </ul>
          <Show when={menu()}>
            {(open) => (
              <Menu
                anchor={open().anchor}
                label={`${open().account.name} options`}
                placement="bottom-end"
                groups={menuGroups(open().account)}
                onClose={() => setMenu(null)}
              />
            )}
          </Show>
          <Show when={removing()}>
            {(account) => (
              <ConfirmDialog
                title={`Remove ${account().name}?`}
                body="It's taken out of every backup order."
                confirmLabel="Remove account"
                busyLabel="Removing…"
                danger
                busy={busy()}
                error={removeError()}
                onConfirm={() => void removeAccount()}
                onCancel={() => setRemoving(null)}
              />
            )}
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
                          {freeName(entry)
                            ? `${freeName(entry)} (free)`
                            : (entry.model ?? "Default model")}
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
              <Show when={freeToAdd().length}>
                <button
                  type="button"
                  class="models-button"
                  disabled={busy()}
                  onClick={() => void saveOrder([...order(), ...freeToAdd()])}
                >
                  Add free models
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
