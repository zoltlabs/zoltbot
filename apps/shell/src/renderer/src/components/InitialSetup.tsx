import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type {
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
  AppSetupState,
  DesktopPlatform,
  MacPermissionId,
  MacPermissionsState,
} from "../../../shared/ipc";
import { ProviderPicker, type ProviderPickerOption } from "./ProviderPicker";

interface InitialSetupProps {
  reviewing?: boolean;
  state: AppSetupState;
  agentStatus: AgentStatus;
  platform: DesktopPlatform;
  onSave: (provider: AgentProviderId) => Promise<void>;
  onCheckAgents: () => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  onClose?: () => void;
}

const PERMISSIONS: Array<{
  id: MacPermissionId;
  title: string;
  description: string;
}> = [
  {
    id: "screen-recording",
    title: "Screen Recording",
    description: "Let Computer Use see what is on your screen.",
  },
  {
    id: "accessibility",
    title: "Accessibility",
    description: "Let Computer Use control apps on your Mac.",
  },
];

const EMPTY_PERMISSIONS: MacPermissionsState = {
  screenRecording: "unknown",
  accessibility: "unknown",
};

export function InitialSetup(props: InitialSetupProps) {
  const [selectedProvider, setSelectedProvider] = createSignal<AgentProviderId | null>(
    props.state.preferredProvider,
  );
  const [permissions, setPermissions] = createSignal(EMPTY_PERMISSIONS);
  const [saving, setSaving] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [permissionBusy, setPermissionBusy] = createSignal<MacPermissionId | null>(null);
  const [error, setError] = createSignal("");
  const providers = createMemo(() => props.agentStatus.providers ?? []);
  const providerOptions = createMemo<ProviderPickerOption[]>(() =>
    providers().map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      state: provider.state,
      message: provider.message,
      email: provider.email,
    })),
  );
  const selected = createMemo(() =>
    providers().find((provider) => provider.id === selectedProvider()),
  );

  createEffect(() => {
    const options = providerOptions();
    const current = selectedProvider();
    if (current && options.some((provider) => provider.id === current)) return;
    const preferred = options.find((provider) => provider.id === props.state.preferredProvider);
    const available = options.find((provider) => provider.state === "available");
    setSelectedProvider(preferred?.id ?? available?.id ?? options[0]?.id ?? null);
  });

  async function refreshPermissions(): Promise<void> {
    if (props.platform !== "darwin") return;
    try {
      setPermissions(await window.openbot.getMacPermissions());
    } catch (cause) {
      setError(errorMessage(cause, "Zoltbot could not read macOS permissions."));
    }
  }

  onMount(() => {
    void refreshPermissions();
    const handleFocus = () => void refreshPermissions();
    window.addEventListener("focus", handleFocus);
    onCleanup(() => window.removeEventListener("focus", handleFocus));
  });

  async function requestPermission(permission: MacPermissionId): Promise<void> {
    if (permissionBusy()) return;
    setPermissionBusy(permission);
    setError("");
    try {
      setPermissions(await window.openbot.requestMacPermission(permission));
    } catch (cause) {
      setError(errorMessage(cause, "Zoltbot could not open this macOS permission."));
    } finally {
      setPermissionBusy(null);
    }
  }

  async function save(): Promise<void> {
    const provider = selectedProvider();
    if (!provider || saving()) return;
    setSaving(true);
    setError("");
    try {
      await props.onSave(provider);
    } catch (cause) {
      setError(errorMessage(cause, "Zoltbot could not save your agent."));
      setSaving(false);
    }
  }

  async function checkAgents(): Promise<void> {
    if (checking()) return;
    setChecking(true);
    setError("");
    try {
      await props.onCheckAgents();
    } catch (cause) {
      setError(errorMessage(cause, "Zoltbot could not check your agents."));
    } finally {
      setChecking(false);
    }
  }

  function openUrl(url: string): void {
    setError("");
    void props
      .onOpenUrl(url)
      .catch((cause) => setError(errorMessage(cause, "Zoltbot could not open the link.")));
  }

  return (
    <main class="initial-setup-screen">
      <section
        class="initial-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="initial-setup-title"
        aria-describedby={props.reviewing ? undefined : "initial-setup-description"}
      >
        <header class="initial-setup-header">
          <h1 id="initial-setup-title">
            {props.reviewing ? "Agents & permissions" : "Set up a coding agent"}
          </h1>
          <Show when={!props.reviewing}>
            <p id="initial-setup-description" class="initial-setup-intro">
              Install or sign in to one of these agents to start.
            </p>
          </Show>
        </header>

        <Show
          when={providerOptions().length > 0}
          fallback={
            <p class="agent-setup-empty" role="status">
              {props.agentStatus.phase === "ready"
                ? "No coding agents found."
                : (props.agentStatus.message ?? "Connecting to Zoltbot…")}
            </p>
          }
        >
          <ProviderPicker
            value={selectedProvider()}
            options={providerOptions()}
            ariaLabel="Default agent"
            label="Default agent"
            disabled={saving()}
            allowUnavailableSelection
            focusFirst
            onChange={setSelectedProvider}
          />
          <Show when={selected()}>
            {(provider) => <AgentSetupStep provider={provider()} onOpenUrl={openUrl} />}
          </Show>
        </Show>

        <Show when={props.platform === "darwin"}>
          <section class="mac-permissions" aria-labelledby="mac-permissions-title">
            <div class="mac-permissions-heading">
              <div>
                <h2 id="mac-permissions-title">Mac permissions</h2>
                <p>Optional. Computer Use needs both permissions.</p>
              </div>
            </div>
            <div class="mac-permission-list">
              <For each={PERMISSIONS}>
                {(permission) => {
                  const state = () => permissionState(permissions(), permission.id);
                  return (
                    <div class="mac-permission-row">
                      <span class="mac-permission-copy">
                        <strong>{permission.title}</strong>
                        <small>{permission.description}</small>
                      </span>
                      <button
                        type="button"
                        class="mac-permission-action"
                        classList={{ "mac-permission-allowed": state() === "granted" }}
                        disabled={
                          permissionBusy() !== null ||
                          state() === "granted" ||
                          state() === "restricted"
                        }
                        onClick={() => void requestPermission(permission.id)}
                      >
                        {permissionBusy() === permission.id
                          ? "Checking…"
                          : permissionLabel(state())}
                      </button>
                    </div>
                  );
                }}
              </For>
            </div>
          </section>
        </Show>

        <Show when={error()}>
          <p class="initial-setup-error" role="alert">
            {error()}
          </p>
        </Show>

        <div class="initial-setup-actions">
          <Show
            when={props.reviewing}
            fallback={
              <button
                type="button"
                class="initial-setup-secondary"
                disabled={checking() || props.agentStatus.phase !== "ready"}
                onClick={() => void checkAgents()}
              >
                {checking() ? "Checking…" : "Check again"}
              </button>
            }
          >
            <button type="button" class="initial-setup-secondary" onClick={props.onClose}>
              Cancel
            </button>
          </Show>
          <button
            type="button"
            class="initial-setup-save"
            disabled={saving() || !selected()}
            onClick={() => void save()}
          >
            {saving()
              ? "Saving…"
              : props.reviewing
                ? "Save changes"
                : selected()
                  ? `Continue with ${selected()?.name || selected()?.id}`
                  : "Choose an agent"}
          </button>
        </div>
      </section>
    </main>
  );
}

/** What to do next for the chosen agent: install it, sign in, or update it. */
function AgentSetupStep(props: {
  provider: AgentProviderStatus;
  onOpenUrl: (url: string) => void;
}) {
  const name = () => props.provider.name || props.provider.id;
  const command = () =>
    props.provider.state === "not-installed"
      ? props.provider.installCommand
      : props.provider.state === "sign-in-required"
        ? props.provider.loginCommand
        : null;
  return (
    <Show when={props.provider.state !== "available" && props.provider.message}>
      {(message) => (
        <div class="agent-setup-step" role="status">
          <p>{message()}</p>
          <Show when={command()}>
            {(text) => (
              <p class="agent-setup-command">
                <span>Run in Terminal:</span>
                <code>{text()}</code>
              </p>
            )}
          </Show>
          <Show when={props.provider.state === "not-installed" && props.provider.installUrl}>
            {(url) => (
              <button
                type="button"
                class="mac-permission-action agent-setup-link"
                onClick={() => props.onOpenUrl(url())}
              >
                How to install {name()}
              </button>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function permissionState(
  permissions: MacPermissionsState,
  permission: MacPermissionId,
): MacPermissionsState["screenRecording"] {
  return permission === "screen-recording"
    ? permissions.screenRecording
    : permissions.accessibility;
}

function permissionLabel(state: MacPermissionsState["screenRecording"]): string {
  if (state === "granted") return "Allowed";
  if (state === "denied" || state === "unknown") return "Open Settings";
  if (state === "restricted") return "Restricted";
  return "Allow";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
