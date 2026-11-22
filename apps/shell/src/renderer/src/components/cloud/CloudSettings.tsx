import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type {
  CloudDesktopApi,
  CloudSecretName,
  CloudSetting,
  CloudSettingsStatus,
  MacExecutionMode,
} from "../../../../shared/cloud";
import { Cluster, Field, Select, SettingsRow, Stack } from "../../kit";
import { CloudPanel } from "./CloudPanel";

const keys: ReadonlyArray<{ name: CloudSecretName; label: string }> = [
  { name: "anthropic", label: "Anthropic API key" },
  { name: "openai", label: "OpenAI API key" },
  { name: "github", label: "GitHub token" },
];
const modes = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask every time" },
  { value: "allow_listed", label: "Allow listed commands" },
] as const;

export function CloudSettings(props: {
  api: CloudDesktopApi;
  accountSignedIn: boolean;
  online: boolean;
  sidebarCollapsed: boolean;
  onShowSidebar(): void;
  onSignIn(): Promise<void>;
  onCancelSignIn(): void;
}) {
  const [status, setStatus] = createSignal<CloudSettingsStatus>();
  const [busy, setBusy] = createSignal(false);
  const [signingIn, setSigningIn] = createSignal(false);
  const [error, setError] = createSignal("");
  let serial = 0;
  const load = async () => {
    const request = ++serial;
    setError("");
    setBusy(true);
    try {
      const next = await props.api.settings();
      if (request === serial) setStatus(next);
    } catch {
      if (request === serial) setError("Couldn’t load Cloud settings. Try again.");
    } finally {
      if (request === serial) setBusy(false);
    }
  };
  createEffect(
    on(
      () => [props.accountSignedIn, props.online] as const,
      ([signedIn]) => {
        if (!signedIn) setStatus(undefined);
        void load();
      },
    ),
  );
  onCleanup(() => serial++);

  const update = async (input: CloudSetting) => {
    if (busy()) return;
    const request = ++serial;
    setBusy(true);
    setError("");
    try {
      const next = await props.api.update(input);
      if (request === serial) setStatus(next);
    } catch {
      if (request === serial) setError("Couldn’t save the change. Try again.");
    } finally {
      if (request === serial) setBusy(false);
    }
  };
  const signIn = async () => {
    setSigningIn(true);
    setError("");
    try {
      await props.onSignIn();
      await load();
    } catch {
      setError("Couldn’t sign in. Try again.");
    } finally {
      setSigningIn(false);
    }
  };
  const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const hours = (seconds: number) => number.format(seconds / 3600);
  return (
    <CloudPanel
      title="Zoltbot Cloud"
      sidebarCollapsed={props.sidebarCollapsed}
      onShowSidebar={props.onShowSidebar}
    >
      <Stack gap={6}>
        <div role="status">{busy() && !status() ? "Loading Cloud settings…" : ""}</div>
        <Show when={error()}>
          <Cluster>
            <p class="models-error" role="alert">
              {error()}
            </p>
            <button
              type="button"
              class="models-button"
              disabled={busy()}
              onClick={() => void load()}
            >
              Reload settings
            </button>
          </Cluster>
        </Show>
        <Show when={status()}>
          {(value) => (
            <>
              <Show when={!value().configured}>
                <p>Cloud is unavailable in this build.</p>
              </Show>
              <Show when={value().configured && !value().account}>
                <Cluster>
                  <button
                    type="button"
                    class="models-button models-button-primary"
                    disabled={signingIn()}
                    onClick={() => void signIn()}
                  >
                    Continue with Google
                  </button>
                  <Show when={signingIn()}>
                    <button type="button" class="models-button" onClick={props.onCancelSignIn}>
                      Cancel sign-in
                    </button>
                  </Show>
                </Cluster>
              </Show>
              <Show when={value().account?.sessionId} keyed>
                {(sessionId) => (
                  <Stack gap={6}>
                    <Show when={!value().online}>
                      <p role="status">Cloud is offline. Reconnect to change settings.</p>
                    </Show>
                    <Show when={value().online && !value().eligible}>
                      <p>Cloud access is unavailable for this account.</p>
                    </Show>
                    <SettingsRow
                      label="Enable Zoltbot Cloud"
                      control={(id) => (
                        <input
                          id={id}
                          type="checkbox"
                          checked={value().enabled}
                          disabled={busy() || !value().online || !value().eligible}
                          onChange={(event) =>
                            void update({
                              type: "enabled",
                              sessionId: sessionId,
                              value: event.currentTarget.checked,
                            })
                          }
                        />
                      )}
                    />
                    <Show when={value().enabled && value().eligible}>
                      <section class="models-section" aria-labelledby="cloud-keys">
                        <h2 class="models-heading" id="cloud-keys">
                          API keys
                        </h2>
                        <Stack gap={3}>
                          <For each={keys}>
                            {(key) => (
                              <CloudSecretForm
                                api={props.api}
                                disabled={!value().online}
                                sessionId={sessionId}
                                label={key.label}
                                name={key.name}
                              />
                            )}
                          </For>
                        </Stack>
                      </section>
                      <section class="models-section" aria-labelledby="cloud-mac">
                        <h2 class="models-heading" id="cloud-mac">
                          This Mac
                        </h2>
                        <SettingsRow
                          label="Run cloud tasks on this Mac"
                          control={(id) => (
                            <input
                              id={id}
                              type="checkbox"
                              checked={value().runTasksOnMac}
                              disabled={busy() || !value().online}
                              onChange={(event) =>
                                void update({
                                  type: "runner",
                                  sessionId: sessionId,
                                  value: event.currentTarget.checked,
                                })
                              }
                            />
                          )}
                        />
                        <SettingsRow
                          label="Run on my Mac"
                          control={(id) => (
                            <Select<MacExecutionMode>
                              id={id}
                              label="Run on my Mac"
                              value={value().macExecution}
                              options={modes}
                              disabled={busy() || !value().online}
                              onChange={(mode) =>
                                void update({
                                  type: "execution",
                                  sessionId: sessionId,
                                  value: mode,
                                })
                              }
                            />
                          )}
                        />
                        <For each={value().projects}>
                          {(project) => (
                            <SettingsRow
                              label={project.name}
                              control={(id) => (
                                <Cluster>
                                  <Show when={project.folder}>
                                    <span>{project.folder}</span>
                                  </Show>
                                  <button
                                    id={id}
                                    type="button"
                                    class="models-button"
                                    disabled={busy() || !value().online}
                                    aria-label={`Link folder for ${project.name}`}
                                    onClick={() =>
                                      void update({
                                        type: "folder",
                                        sessionId: sessionId,
                                        projectId: project.id,
                                      })
                                    }
                                  >
                                    Link folder
                                  </button>
                                </Cluster>
                              )}
                            />
                          )}
                        </For>
                      </section>
                      <Show when={value().usage}>
                        {(usage) => (
                          <section class="models-section" aria-labelledby="cloud-usage">
                            <h2 id="cloud-usage" class="models-heading">
                              Usage this month
                            </h2>
                            <p>
                              {hours(usage().sandboxSeconds)} of {hours(usage().limitSeconds)} hours
                            </p>
                          </section>
                        )}
                      </Show>
                    </Show>
                  </Stack>
                )}
              </Show>
            </>
          )}
        </Show>
      </Stack>
    </CloudPanel>
  );
}

function CloudSecretForm(props: {
  api: CloudDesktopApi;
  disabled: boolean;
  sessionId: string;
  label: string;
  name: CloudSecretName;
}) {
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal("");
  const [error, setError] = createSignal("");
  let field: HTMLInputElement | undefined;
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy() || props.disabled || !field) return;
    const value = field.value;
    field.value = "";
    if (!value.trim()) {
      setError("Enter the key or token.");
      field.focus();
      return;
    }
    setBusy(true);
    setStatus("");
    setError("");
    try {
      await props.api.saveSecret({ sessionId: props.sessionId, name: props.name, value });
      setStatus("Saved");
    } catch {
      setError("Couldn’t save it. Re-enter the value and try again.");
      field.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)}>
      <Field
        label={props.label}
        error={error()}
        input={(id, describedBy) => (
          <Cluster>
            <input
              ref={field}
              id={id}
              name={props.name}
              type="password"
              autocomplete="off"
              aria-invalid={!!error()}
              aria-describedby={describedBy}
              class="models-limit-input"
              disabled={props.disabled || busy()}
            />
            <button
              type="submit"
              class="models-button"
              disabled={props.disabled || busy()}
              aria-label={`Save ${props.label}`}
            >
              Save
            </button>
            <span role="status">{status()}</span>
          </Cluster>
        )}
      />
    </form>
  );
}
