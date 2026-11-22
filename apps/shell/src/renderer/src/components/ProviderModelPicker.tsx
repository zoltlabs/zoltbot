import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  on,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "solid-js/web";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentReasoningEffort,
  AgentStatus,
} from "../../../shared/ipc";
import { t } from "../i18n";
import { AgentLogo, floatingLayer, Select } from "../kit";
import { returnFocus, useDismiss, useFloatingPosition } from "../kit/floating";
import { modelSearchScore } from "../model-search";
import { refreshStarredModels, starredIds, toggleStarredModel } from "../starred-models";
import { reasoningLabel } from "./conversation/AgentSettings";

interface ProviderModelPickerProps {
  value: AgentModelId;
  modelOptions: AgentModelOption[];
  agentStatus: AgentStatus;
  variant?: "pill" | "field";
  ariaLabel?: string;
  label?: string;
  disabled?: boolean;
  /** Why the picker is disabled. Shown under a field; read to screen readers on a pill. */
  disabledReason?: string;
  onChange: (model: AgentModelId) => void;
  /** The effort the agent runs at. With onEffortChange, the panel offers the model's levels. */
  effort?: AgentReasoningEffort;
  onEffortChange?(effort: AgentReasoningEffort): void;
  /** A5: Fast mode on or off, or null when the provider has no faster tier (no switch). */
  fastMode?: boolean | null;
  /** Resolves false when the change wasn't saved. */
  onFastModeChange?(on: boolean): Promise<boolean>;
  /** Opens agent setup, for an agent that isn't ready or to add one. */
  onSetUpAgent?(): void;
}

/** How many of an agent's models show before "Older models". Providers list newest first. */
const RECENT = 6;
/** Agents a new chat prefers, in onboarding order. The rail lists them first. */
const PREFERRED = ["claude", "codex", "antigravity"];

interface Agent {
  id: AgentProviderId;
  name: string;
  status: AgentProviderStatus;
  models: AgentModelOption[];
}

/**
 * Picks the agent's model. A rail lists the coding agents; the panel beside it lists the chosen
 * agent's models, newest first, with older ones folded away. Search looks through every agent.
 */
export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  createEffect(() => {
    if (props.disabled) setOpen(false);
  });
  const agents = createMemo(() => listAgents(props.modelOptions, props.agentStatus));
  const current = createMemo(() => findModel(agents(), props.value));
  const field = () => props.variant === "field";
  // Agents asked for their models since the picker last opened, until the answer arrives.
  const [loading, setLoading] = createSignal<AgentProviderId[]>([]);
  createEffect(
    on(open, (isOpen) => {
      if (!isOpen) return;
      const missing = untrack(agents)
        .filter((row) => row.status.state === "available" && !row.models.length)
        .map((row) => row.id);
      const refresh = window.openbot?.agent?.refreshModels;
      if (!missing.length || !refresh) return;
      setLoading(missing);
      void refresh(missing)
        .catch(() => undefined)
        .finally(() => setLoading([]));
    }),
  );
  const reasonId = createUniqueId();
  const effortId = createUniqueId();
  const reason = () => (props.disabled ? props.disabledReason : undefined);
  const modelName = () => displayModelName(current()?.model.name, props.value);
  const effortText = () =>
    props.effort && props.onEffortChange && current()?.model.supportedReasoningEfforts.length
      ? reasoningLabel(props.effort)
      : "";

  return (
    <span class="provider-model-picker" classList={{ "provider-model-picker-field": field() }}>
      <Show when={field()}>
        <span class="provider-model-field-label" aria-hidden="true">
          {props.label ?? "Model"}
        </span>
      </Show>
      <button
        ref={trigger}
        type="button"
        class={`zb-kit-trigger ${field() ? "provider-model-trigger-field" : "provider-model-trigger-pill"}`}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-label={`${props.ariaLabel ?? "Agent model"}: ${modelName()}`}
        aria-describedby={
          [reason() ? reasonId : "", effortText() ? effortId : ""].filter(Boolean).join(" ") ||
          undefined
        }
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Show when={current()}>
          {(found) => (
            <span class="zb-kit-option-icon">
              <AgentLogo agent={found().agent} />
            </span>
          )}
        </Show>
        <span class="zb-kit-trigger-text">{modelName()}</span>
        <Show when={effortText()}>
          <span id={effortId} class="provider-model-trigger-effort">
            · {effortText()}
          </span>
        </Show>
        <svg class="zb-kit-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
      <Show when={open() && trigger}>
        {(anchor) => (
          <ModelPanel
            anchor={anchor()}
            picker={props}
            agents={agents()}
            loading={loading()}
            initialAgent={current()?.agent.id ?? agents()[0]?.id}
            onClose={() => setOpen(false)}
          />
        )}
      </Show>
      <Show when={reason()}>
        <span id={reasonId} class={field() ? "provider-model-disabled-reason" : "sr-only"}>
          {reason()}
        </span>
      </Show>
    </span>
  );
}

function ModelPanel(props: {
  anchor: HTMLElement;
  picker: ProviderModelPickerProps;
  agents: Agent[];
  initialAgent: AgentProviderId | undefined;
  /** Agents whose models are being fetched. */
  loading: AgentProviderId[];
  onClose(): void;
}) {
  let element: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  const listId = createUniqueId();
  const headingId = createUniqueId();
  const [agentId, setAgentId] = createSignal(props.initialAgent);
  const [query, setQuery] = createSignal("");
  const [olderOpen, setOlderOpen] = createSignal(false);
  const [active, setActive] = createSignal(0);
  const agent = () => props.agents.find((row) => row.id === agentId());
  const ready = () => agent()?.status.state === "available";

  /** The chosen agent's models: starred first, then the provider's order. */
  const sorted = createMemo(() => {
    const models = agent()?.models ?? [];
    const starred = models.filter((model) => starredIds().includes(model.id));
    return [...starred, ...models.filter((model) => !starred.includes(model))];
  });
  const recent = () => sorted().slice(0, RECENT);
  const older = () => sorted().slice(RECENT);
  // Open "Older models" when the model in use is one of them, so the check mark is visible.
  createEffect(() => {
    if (older().some((model) => model.id === props.picker.value)) setOlderOpen(true);
  });

  const results = createMemo(() => {
    const text = query().trim();
    if (!text) return [];
    return props.agents
      .filter((row) => row.status.state === "available")
      .flatMap((row) =>
        row.models.map((model) => ({
          model,
          agent: row,
          score: modelSearchScore(text, displayModelName(model.name, model.id), row.name),
        })),
      )
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ model, agent }) => ({ model, agent }));
  });
  const searching = () => query().trim().length > 0;
  /** The rows the arrow keys move through, in screen order. */
  const visible = createMemo((): { model: AgentModelOption; agent?: Agent }[] =>
    searching()
      ? results()
      : ready()
        ? [...recent(), ...(olderOpen() ? older() : [])].map((model) => ({ model }))
        : [],
  );
  const activeRow = () => visible()[Math.min(active(), visible().length - 1)];
  const optionId = (row: { model: AgentModelOption; agent?: Agent }) =>
    `${listId}-${(row.agent?.id ?? "") + row.model.id}`.replace(
      /[^A-Za-z0-9_-]/g,
      (char) => `_${char.charCodeAt(0)}`,
    );

  useFloatingPosition({
    anchor: () => props.anchor,
    floating: () => element,
    placement: "bottom-end",
  });
  useDismiss({
    open: () => true,
    anchor: () => props.anchor,
    floating: () => element,
    onDismiss: () => props.onClose(),
  });
  queueMicrotask(() => {
    refreshStarredModels();
    const index = visible().findIndex((row) => row.model.id === props.picker.value);
    setActive(Math.max(0, index));
    input?.focus();
  });

  const choose = (model: AgentModelOption | undefined) => {
    if (!model) return;
    returnFocus(props.anchor);
    props.onClose();
    props.picker.onChange(model.id);
  };
  const setUp = () => {
    returnFocus(props.anchor);
    props.onClose();
    props.picker.onSetUpAgent?.();
  };
  const scrollActive = () =>
    queueMicrotask(() => {
      const row = activeRow();
      if (row) document.getElementById(optionId(row))?.scrollIntoView?.({ block: "nearest" });
    });

  const railKeydown = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = props.agents[(index + step + props.agents.length) % props.agents.length];
    if (!next) return;
    setAgentId(next.id);
    setActive(0);
    element?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(next.id)}"]`)?.focus();
  };

  const row = (entry: { model: AgentModelOption; agent?: Agent }) => {
    const selected = () => entry.model.id === props.picker.value;
    const isDefault = () => entry.model.id === (entry.agent ?? agent())?.models[0]?.id;
    const label = () => displayModelName(entry.model.name, entry.model.id);
    return (
      <div
        id={optionId(entry)}
        role="option"
        class="zb-kit-option model-panel-option"
        classList={{ active: activeRow()?.model === entry.model }}
        aria-selected={selected()}
        aria-label={[
          label(),
          isDefault() && !entry.agent ? t("models.default") : "",
          entry.agent?.name ?? "",
          starredIds().includes(entry.model.id) ? t("models.starred") : "",
        ]
          .filter(Boolean)
          .join(", ")}
        data-label={label()}
        tabIndex={-1}
        onClick={() => choose(entry.model)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose(entry.model);
          }
        }}
        onPointerMove={() => setActive(visible().findIndex((item) => item.model === entry.model))}
      >
        <span class="model-panel-radio" classList={{ on: selected() }} aria-hidden="true" />
        <span class="zb-kit-option-label">{label()}</span>
        <Show when={isDefault() && !entry.agent}>
          <span class="model-panel-badge">{t("models.default")}</span>
        </Show>
        <Show when={entry.agent}>
          {(owner) => <span class="zb-kit-option-detail">{owner().name}</span>}
        </Show>
        <Show when={starredIds().includes(entry.model.id)}>
          <span class="model-panel-star" aria-hidden="true">
            ★
          </span>
        </Show>
      </div>
    );
  };

  const effortOptions = () => {
    const model = findModel(props.agents, props.picker.value)?.model;
    return (model?.supportedReasoningEfforts ?? []) as AgentReasoningEffort[];
  };
  const showEffort = () => Boolean(props.picker.onEffortChange) && effortOptions().length > 0;
  const showSpeed = () =>
    typeof props.picker.fastMode === "boolean" && Boolean(props.picker.onFastModeChange);

  return (
    <Portal mount={floatingLayer(props.anchor)}>
      <div
        ref={element}
        class="zb-kit-floating model-panel"
        role="dialog"
        aria-label={t("models.choose")}
        data-kit-overlay="combobox"
      >
        <div class="model-panel-rail">
          <div
            class="model-panel-tabs"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("models.agents")}
          >
            <For each={props.agents}>
              {(row, index) => (
                <button
                  type="button"
                  role="tab"
                  class="model-panel-agent"
                  classList={{ unready: row.status.state !== "available" }}
                  data-agent={row.id}
                  aria-selected={row.id === agentId()}
                  aria-controls={listId}
                  aria-label={
                    row.status.state === "available"
                      ? row.name
                      : `${row.name}, ${agentStatusText(row.status)}`
                  }
                  title={row.name}
                  tabIndex={row.id === agentId() ? 0 : -1}
                  onClick={() => {
                    setAgentId(row.id);
                    setQuery("");
                    setActive(0);
                    setOlderOpen(false);
                  }}
                  onKeyDown={(event) => railKeydown(event, index())}
                >
                  <AgentLogo agent={row} size={20} />
                </button>
              )}
            </For>
          </div>
          <Show when={props.picker.onSetUpAgent}>
            <button
              type="button"
              class="model-panel-agent model-panel-add"
              aria-label={t("models.addAgent")}
              title={t("models.addAgent")}
              onClick={setUp}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" />
              </svg>
            </button>
          </Show>
        </div>
        <div class="model-panel-main" role="tabpanel" aria-labelledby={headingId}>
          <Show when={!searching()}>
            <div class="model-panel-head">
              <div id={headingId} class="model-panel-title">
                {agent()?.name}
              </div>
              <Show when={agent()?.status.version}>
                <div class="model-panel-version">{agent()?.status.version}</div>
              </Show>
            </div>
          </Show>
          <div class="model-panel-search">
            <input
              ref={input}
              role="combobox"
              aria-label={t("models.search")}
              placeholder={t("models.search")}
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeRow() ? optionId(activeRow() as never) : undefined}
              value={query()}
              onInput={(event) => {
                setQuery(event.currentTarget.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                const count = visible().length;
                if (event.key === "ArrowDown" && count > 0) {
                  event.preventDefault();
                  setActive((active() + 1) % count);
                  scrollActive();
                } else if (event.key === "ArrowUp" && count > 0) {
                  event.preventDefault();
                  setActive((active() - 1 + count) % count);
                  scrollActive();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(activeRow()?.model);
                }
              }}
            />
            <Show when={activeRow()}>
              {(row) => {
                const starred = () => starredIds().includes(row().model.id);
                const name = () => displayModelName(row().model.name, row().model.id);
                return (
                  <button
                    type="button"
                    class="zb-kit-star-button"
                    classList={{ "zb-kit-starred": starred() }}
                    aria-label={
                      starred()
                        ? t("models.unstar", { name: name() })
                        : t("models.star", { name: name() })
                    }
                    title={
                      starred()
                        ? t("models.unstar", { name: name() })
                        : t("models.star", { name: name() })
                    }
                    onClick={() => toggleStarredModel(row().model.id)}
                  >
                    <StarGlyph filled={starred()} />
                  </button>
                );
              }}
            </Show>
          </div>
          <div id={listId} class="model-panel-list" role="listbox" aria-label={t("models.search")}>
            <Show
              when={searching()}
              fallback={
                <Show
                  when={ready()}
                  fallback={
                    <div class="model-panel-note">
                      <p>
                        {agent() ? agentStatusText(agent()?.status as AgentProviderStatus) : ""}
                      </p>
                      <Show when={props.picker.onSetUpAgent}>
                        <button type="button" class="zb-kit-button" onClick={setUp}>
                          {t("models.setUp")}
                        </button>
                      </Show>
                    </div>
                  }
                >
                  <Show
                    when={sorted().length}
                    fallback={
                      <p class="model-panel-note" role="status">
                        {props.loading.includes(agentId() as AgentProviderId)
                          ? t("models.loading")
                          : t("models.noModels")}
                      </p>
                    }
                  >
                    <For each={recent()}>{(model) => row({ model })}</For>
                    <Show when={older().length}>
                      <button
                        type="button"
                        class="model-panel-older"
                        aria-expanded={olderOpen()}
                        onClick={() => setOlderOpen(!olderOpen())}
                      >
                        <span>{t("models.older")}</span>
                        <span class="model-panel-badge">{older().length}</span>
                        <svg
                          class="zb-kit-chevron"
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          aria-hidden="true"
                        >
                          <path
                            d={olderOpen() ? "m3 7.5 3-3 3 3" : "m3 4.5 3 3 3-3"}
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.4"
                          />
                        </svg>
                      </button>
                      <Show when={olderOpen()}>
                        <For each={older()}>{(model) => row({ model })}</For>
                      </Show>
                    </Show>
                  </Show>
                </Show>
              }
            >
              <For each={results()}>{(entry) => row(entry)}</For>
              <Show when={results().length === 0}>
                <div class="zb-kit-empty-row" role="status">
                  {t("models.noMatch")}
                </div>
              </Show>
            </Show>
          </div>
          <Show when={showEffort() || showSpeed()}>
            <div class="model-panel-footer">
              <Show when={showEffort()}>
                <FooterRow label={t("models.effort")}>
                  {(id) => (
                    <Select
                      id={id}
                      label={t("models.effort")}
                      value={props.picker.effort ?? null}
                      options={effortOptions().map((effort) => ({
                        value: effort,
                        label: reasoningLabel(effort),
                      }))}
                      onChange={(effort) => props.picker.onEffortChange?.(effort)}
                    />
                  )}
                </FooterRow>
              </Show>
              <Show when={showSpeed()}>
                <SpeedRow
                  on={props.picker.fastMode === true}
                  onChange={(on) => props.picker.onFastModeChange?.(on) ?? Promise.resolve(false)}
                />
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

function FooterRow(props: { label: string; children: (id: string) => JSX.Element }) {
  const id = createUniqueId();
  return (
    <div class="model-panel-footer-row">
      <label for={id}>{props.label}</label>
      {props.children(id)}
    </div>
  );
}

/** A5: the faster, costlier tier. The cost shows while it is on; a failed save says so. */
function SpeedRow(props: { on: boolean; onChange(on: boolean): Promise<boolean> }) {
  const noteId = createUniqueId();
  const [failed, setFailed] = createSignal<"on" | "off" | null>(null);
  const change = async (next: boolean) => {
    if (next === props.on) return;
    setFailed(null);
    if (!(await props.onChange(next))) setFailed(next ? "on" : "off");
  };
  const note = () =>
    failed() === "on"
      ? t("models.fastMode.errorOn")
      : failed() === "off"
        ? t("models.fastMode.errorOff")
        : props.on
          ? t("models.fastMode.cost")
          : undefined;
  return (
    <>
      <FooterRow label={t("models.speed")}>
        {(id) => (
          <Select
            id={id}
            label={t("models.speed")}
            value={props.on ? "fast" : "standard"}
            describedBy={note() ? noteId : undefined}
            options={[
              { value: "standard", label: t("models.speed.standard") },
              { value: "fast", label: t("models.speed.fast") },
            ]}
            onChange={(value) => void change(value === "fast")}
          />
        )}
      </FooterRow>
      <Show when={note()}>
        <p
          id={noteId}
          class={failed() ? "zb-kit-error" : "zb-kit-consequence"}
          role={failed() ? "alert" : undefined}
        >
          {note()}
        </p>
      </Show>
    </>
  );
}

function StarGlyph(props: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z"
        fill={props.filled ? "currentColor" : "none"}
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/**
 * Every agent that has models or is installed, ready ones first in onboarding order. Agents that
 * aren't installed stay out: there is nothing to pick or sign in to.
 */
export function listAgents(options: AgentModelOption[], status: AgentStatus): Agent[] {
  const ids: AgentProviderId[] = [];
  for (const option of options) if (!ids.includes(option.provider)) ids.push(option.provider);
  for (const provider of status.providers ?? [])
    if (provider.state !== "not-installed" && !ids.includes(provider.id)) ids.push(provider.id);
  const rank = (id: AgentProviderId) => {
    const index = PREFERRED.indexOf(id);
    return index < 0 ? PREFERRED.length : index;
  };
  return ids
    .map((id, order) => {
      const models = options.filter((option) => option.provider === id);
      const state = providerAvailability(status, options, id);
      const name =
        status.providers?.find((provider) => provider.id === id)?.name ||
        models[0]?.providerName ||
        id;
      return { agent: { id, name, status: state, models }, order };
    })
    .sort(
      (a, b) =>
        Number(b.agent.status.state === "available") -
          Number(a.agent.status.state === "available") ||
        rank(a.agent.id) - rank(b.agent.id) ||
        a.order - b.order,
    )
    .map((row) => row.agent);
}

function findModel(agents: Agent[], id: AgentModelId) {
  for (const agent of agents) {
    const model = agent.models.find((row) => row.id === id);
    if (model) return { agent, model };
  }
  return undefined;
}

function providerAvailability(
  status: AgentStatus,
  models: AgentModelOption[],
  provider: AgentProviderId,
): AgentProviderStatus {
  const explicit = status.providers?.find((item) => item.id === provider);
  if (explicit) return explicit;
  if (status.phase === "starting" || status.phase === "restarting") {
    return { id: provider, state: "checking", version: null, message: null };
  }
  const available = models.some((model) => model.provider === provider);
  return {
    id: provider,
    state: available ? "available" : "error",
    version: null,
    message: null,
  };
}

function agentStatusText(status: AgentProviderStatus): string {
  if (status.message) return status.message;
  if (status.state === "sign-in-required") return "Sign in required";
  if (status.state === "not-installed") return "Not installed";
  if (status.state === "outdated") return "Update required";
  if (status.state === "error") return "Unavailable";
  return "Checking";
}

function displayModelName(name: string | undefined, fallback: string): string {
  return name?.replace(/^[\s:–—-]+/, "") || fallback || "Default model";
}
