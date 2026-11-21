// V1: the Vault page. Saved logins and two-step codes, which agents may use each one, and Add,
// Edit and Remove. Values never reach this page except through Show behind Touch ID.
import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type {
  VaultItem,
  VaultItemKind,
  VaultProvider,
  VaultProviderId,
  VaultProviderItem,
} from "../../../../shared/vault";
import { t } from "../../i18n";
import { ConfirmDialog, EmptyState, Menu, showToast, Tooltip } from "../../kit";
import { SidebarToggleIcon } from "../SidebarIcons";
import { ProviderDialog } from "./ProviderDialog";
import { type VaultAgentOption, VaultDialog } from "./VaultDialog";
import "./vault.css";

const MANAGER_NAMES: Record<VaultProviderId, string> = {
  "1password": "1Password",
  bitwarden: "Bitwarden",
  proton: "Proton Pass",
};

function KindIcon(props: { kind: VaultItemKind }) {
  return (
    <svg class="vault-kind" viewBox="0 0 20 20" aria-hidden="true">
      <Switch>
        <Match when={props.kind === "login"}>
          <circle cx="7" cy="10" r="3.5" />
          <path d="M10.5 10H17M14.5 10v2.5" />
        </Match>
        <Match when={props.kind === "secret"}>
          <rect x="4" y="9" width="12" height="8" rx="1.5" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </Match>
        <Match when={props.kind === "totp"}>
          <circle cx="10" cy="10" r="6.5" />
          <path d="M10 6.5V10l2.5 1.5" />
        </Match>
      </Switch>
    </svg>
  );
}

export function VaultPage(props: { sidebarCollapsed: boolean; onShowSidebar: () => void }) {
  const [items, setItems] = createSignal<VaultItem[]>([]);
  const [agents, setAgents] = createSignal<readonly VaultAgentOption[]>([]);
  const [available, setAvailable] = createSignal(true);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<{
    kind: VaultItemKind;
    item?: VaultItem;
    pick?: { provider: VaultProviderId; item: VaultProviderItem };
  } | null>(null);
  // V3: password managers this Mac has; a missing one isn't offered.
  const [providers, setProviders] = createSignal<VaultProvider[]>([]);
  const [picking, setPicking] = createSignal<VaultProvider | null>(null);
  const [managerMenu, setManagerMenu] = createSignal<HTMLElement | null>(null);
  const managers = () => providers().filter((provider) => provider.state !== "missing");
  const managerName = (id: VaultProviderId | undefined) =>
    providers().find((provider) => provider.id === id)?.name ?? MANAGER_NAMES[id ?? "1password"];
  const [menu, setMenu] = createSignal<{ item: VaultItem; anchor: HTMLElement } | null>(null);
  const [removing, setRemoving] = createSignal<VaultItem | null>(null);
  const [removeBusy, setRemoveBusy] = createSignal(false);
  const [removeError, setRemoveError] = createSignal<string | null>(null);
  let heading: HTMLHeadingElement | undefined;

  async function load() {
    try {
      const [list, named] = await Promise.all([
        window.openbot.vault.list(),
        window.openbot.vault.agents(),
      ]);
      setAgents(named);
      setItems(list.items);
      setAvailable(list.available);
      setError(null);
    } catch {
      setError(t("vault.error.load"));
    } finally {
      setLoaded(true);
    }
  }
  onMount(() => {
    heading?.focus();
    void load();
    window.openbot.vault
      .providers()
      .then(setProviders)
      .catch(() => setProviders([]));
  });

  const names = () => new Map(agents().map((agent) => [agent.id, agent.name]));
  const meta = (item: VaultItem) => {
    const who =
      item.agents === "all"
        ? t("vault.allAgents")
        : item.agents.length
          ? item.agents.map((id) => names().get(id) ?? t("vault.removedAgent")).join(", ")
          : t("vault.noAgents");
    const first =
      item.kind === "login"
        ? [item.username, item.source ? managerName(item.source.provider) : undefined]
            .filter(Boolean)
            .join(" · ")
        : item.kind === "secret"
          ? t("vault.kind.secret")
          : t("vault.kind.code");
    return { first, who };
  };

  // A toast left from the last save would sit over the dialog's buttons.
  let dismissToast: (() => void) | undefined;
  function openDialog(open: {
    kind: VaultItemKind;
    item?: VaultItem;
    pick?: { provider: VaultProviderId; item: VaultProviderItem };
  }) {
    dismissToast?.();
    setEditing(open);
  }

  async function remove() {
    const item = removing();
    if (!item || removeBusy()) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await window.openbot.vault.remove(item.id);
      setItems((list) => list.filter((entry) => entry.id !== item.id));
      setRemoving(null);
      showToast({ message: t("vault.removed", { label: item.label }) });
      heading?.focus();
    } catch (failure) {
      setRemoveError(failure instanceof Error ? failure.message : t("vault.error.remove"));
    } finally {
      setRemoveBusy(false);
    }
  }

  const fromManager = () => (
    <Show when={managers().length}>
      <button
        type="button"
        class="zb-kit-button no-drag"
        aria-haspopup={managers().length > 1 ? "menu" : undefined}
        onClick={(event) => {
          const only = managers().length === 1 ? managers()[0] : undefined;
          if (only) {
            dismissToast?.();
            setPicking(only);
          } else setManagerMenu(event.currentTarget);
        }}
      >
        {managers().length === 1
          ? t("vault.provider.addFrom", { name: managers()[0]?.name ?? "" })
          : t("vault.provider.addFromMenu")}
      </button>
    </Show>
  );

  const addButtons = (
    <>
      {fromManager()}
      <button
        type="button"
        class="zb-kit-button no-drag"
        onClick={() => openDialog({ kind: "totp" })}
      >
        {t("vault.addCode")}
      </button>
      <button
        type="button"
        class="zb-kit-button primary no-drag"
        onClick={() => openDialog({ kind: "login" })}
      >
        {t("vault.addLogin")}
      </button>
    </>
  );

  return (
    <main aria-label={t("vault.title")} class="map-panel vault-panel">
      <header class="window-drag map-header vault-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label={t("memory.showSidebar")}
            aria-controls="bot-sidebar"
            aria-expanded="false"
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} class="map-title tasks-title" tabIndex={-1}>
          {t("vault.title")}
        </h1>
        <Show when={available() && items().length}>
          <div class="vault-actions">{addButtons}</div>
        </Show>
      </header>
      <div class="tasks-body vault-body">
        <Show when={error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={loaded() && !error()}>
          <Show
            when={available()}
            fallback={<EmptyState title={t("vault.unavailable")} level={2} />}
          >
            <Show
              when={items().length}
              fallback={
                <EmptyState
                  title={t("vault.empty")}
                  level={2}
                  action={
                    <div class="vault-actions">
                      {fromManager()}
                      <button
                        type="button"
                        class="zb-kit-button primary"
                        onClick={() => openDialog({ kind: "login" })}
                      >
                        {t("vault.addLogin")}
                      </button>
                    </div>
                  }
                />
              }
            >
              <ul class="vault-list">
                <For each={items()}>
                  {(item) => (
                    <li class="vault-row" data-vault-id={item.id}>
                      <KindIcon kind={item.kind} />
                      <div class="vault-copy">
                        <span class="vault-label">{item.label}</span>
                        <span class="vault-meta">
                          <Show when={meta(item).first}>
                            {(first) => <span>{`${first()} · `}</span>}
                          </Show>
                          <span class="vault-who">{meta(item).who}</span>
                        </span>
                      </div>
                      <Tooltip label={t("vault.actionsFor", { label: item.label })}>
                        <button
                          type="button"
                          class="sidebar-icon-button vault-more"
                          aria-label={t("vault.actionsFor", { label: item.label })}
                          aria-haspopup="menu"
                          onClick={(event) => setMenu({ item, anchor: event.currentTarget })}
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <circle cx="5" cy="10" r="1.4" />
                            <circle cx="10" cy="10" r="1.4" />
                            <circle cx="15" cy="10" r="1.4" />
                          </svg>
                        </button>
                      </Tooltip>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={menu()}>
        {(open) => {
          // The menu closes before an item runs, so keep the row it was opened for.
          const { item, anchor } = open();
          return (
            <Menu
              anchor={anchor}
              label={t("vault.actionsFor", { label: item.label })}
              onClose={() => setMenu(null)}
              groups={[
                // A secret from a chat has no site to edit; it can only be removed.
                ...(item.kind === "secret"
                  ? []
                  : [
                      [
                        {
                          id: "edit",
                          label: t("vault.edit"),
                          run: () => openDialog({ kind: item.kind, item }),
                        },
                      ],
                    ]),
                [
                  {
                    id: "remove",
                    label: t("vault.remove"),
                    danger: true,
                    run: () => {
                      setRemoveError(null);
                      setRemoving(item);
                    },
                  },
                ],
              ]}
            />
          );
        }}
      </Show>
      <Show when={managerMenu()}>
        {(anchor) => (
          <Menu
            anchor={anchor()}
            label={t("vault.provider.addFromMenu")}
            onClose={() => setManagerMenu(null)}
            groups={[
              managers().map((provider) => ({
                id: provider.id,
                label: provider.name,
                run: () => {
                  dismissToast?.();
                  setPicking(provider);
                },
              })),
            ]}
          />
        )}
      </Show>
      <Show when={picking()}>
        {(provider) => (
          <ProviderDialog
            provider={provider()}
            onClose={() => setPicking(null)}
            onPick={(item) => {
              const id = provider().id;
              setPicking(null);
              openDialog({ kind: "login", pick: { provider: id, item } });
            }}
          />
        )}
      </Show>
      <Show when={editing()}>
        {(open) => (
          <VaultDialog
            kind={open().kind}
            {...(open().item ? { item: open().item } : {})}
            {...(open().pick ? { pick: open().pick } : {})}
            managerName={managerName(open().pick?.provider ?? open().item?.source?.provider)}
            agents={agents()}
            onClose={() => setEditing(null)}
            onSaved={(saved) => {
              setEditing(null);
              setItems((list) =>
                list.some((entry) => entry.id === saved.id)
                  ? list.map((entry) => (entry.id === saved.id ? saved : entry))
                  : [...list, saved],
              );
              dismissToast = showToast({ message: t("vault.saved", { label: saved.label }) });
            }}
          />
        )}
      </Show>
      <Show when={removing()}>
        {(item) => (
          <ConfirmDialog
            title={t("vault.removeTitle", { label: item().label })}
            body={t("vault.removeBody")}
            confirmLabel={t("vault.remove")}
            danger
            busy={removeBusy()}
            error={removeError()}
            onConfirm={() => void remove()}
            onCancel={() => setRemoving(null)}
          />
        )}
      </Show>
    </main>
  );
}
