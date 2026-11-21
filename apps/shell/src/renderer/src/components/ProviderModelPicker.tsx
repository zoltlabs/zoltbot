import { createMemo, createSignal, createUniqueId, Show } from "solid-js";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
} from "../../../shared/ipc";
import { t } from "../i18n";
import { Combobox, ModelLogo, type PickerOption } from "../kit";
import { modelSearchScore } from "../model-search";
import { refreshStarredModels, starredIds, toggleStarredModel } from "../starred-models";

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
  /** A5: Fast mode on or off, or null when the provider has no faster tier (no switch). */
  fastMode?: boolean | null;
  /** Resolves false when the change wasn't saved. */
  onFastModeChange?(on: boolean): Promise<boolean>;
}

/**
 * Picks the agent's model from every provider's models, grouped by provider, with search.
 * Models of a provider that isn't ready are listed but can't be chosen; their row says why.
 */
export function ProviderModelPicker(props: ProviderModelPickerProps) {
  const providerName = (provider: AgentProviderId): string =>
    props.modelOptions.find((option) => option.provider === provider)?.providerName || provider;
  const defaultModel = (provider: AgentProviderId): AgentModelId | undefined =>
    props.modelOptions.find((option) => option.provider === provider)?.id;

  const starred = (id: AgentModelId) => starredIds().includes(id);
  // A8: starred models first, in their own group.
  const options = createMemo((): PickerOption<AgentModelId>[] => {
    const all = props.modelOptions.map((model) => {
      const status = providerAvailability(
        props.agentStatus,
        props.modelOptions,
        model.provider,
        providerName,
      );
      const available = status.state === "available";
      return {
        value: model.id,
        label: displayModelName(model.name, model.id),
        // An unavailable provider says why in its group name, once, not on every model.
        group: available
          ? providerName(model.provider)
          : `${providerName(model.provider)} · ${providerSummary(model.provider, status)}`,
        icon: () => <ModelLogo model={model} />,
        detail: model.id === defaultModel(model.provider) ? "default" : undefined,
        disabled: !available,
      };
    });
    // One row per starred model: the first that can be chosen, else the first listed.
    const top = starredIds().flatMap((id) => {
      const rows = all.filter((option) => option.value === id);
      const row = rows.find((option) => !option.disabled) ?? rows[0];
      return row ? [row] : [];
    });
    return [
      ...top.map((option) => ({ ...option, group: t("models.starred") })),
      ...all.filter((option) => !top.includes(option)),
    ];
  });
  const providerOf = (id: AgentModelId) =>
    providerName(props.modelOptions.find((model) => model.id === id)?.provider ?? "");
  const field = () => props.variant === "field";
  // A memo, so the switch is built once and keeps focus while it turns on and off.
  const fastModeShown = createMemo(
    () => typeof props.fastMode === "boolean" && Boolean(props.onFastModeChange),
  );
  const reasonId = createUniqueId();
  const reason = () => (props.disabled ? props.disabledReason : undefined);

  return (
    <span class="provider-model-picker" classList={{ "provider-model-picker-field": field() }}>
      <Show when={field()}>
        <span class="provider-model-field-label" aria-hidden="true">
          {props.label ?? "Model"}
        </span>
      </Show>
      <Combobox
        label={props.ariaLabel ?? "Agent model"}
        searchLabel="Search models"
        panelLabel="Choose agent model"
        emptyLabel="No models match"
        value={props.value}
        options={options()}
        disabled={props.disabled}
        describedBy={reason() ? reasonId : undefined}
        placeholder={displayModelName(undefined, props.value)}
        class={field() ? "provider-model-trigger-field" : "provider-model-trigger-pill"}
        onChange={props.onChange}
        onOpen={refreshStarredModels}
        rank={(query, option) => modelSearchScore(query, option.label, providerOf(option.value))}
        star={{
          isStarred: starred,
          toggle: toggleStarredModel,
          label: (option, on) =>
            on
              ? t("models.unstar", { name: option.label })
              : t("models.star", { name: option.label }),
        }}
        footer={
          fastModeShown() ? (
            <FastModeSwitch
              on={props.fastMode === true}
              onChange={(on) => props.onFastModeChange?.(on) ?? Promise.resolve(false)}
            />
          ) : undefined
        }
      />
      <Show when={reason()}>
        <span id={reasonId} class={field() ? "provider-model-disabled-reason" : "sr-only"}>
          {reason()}
        </span>
      </Show>
    </span>
  );
}

/** A5: the faster, costlier tier. The cost shows while it is on; a failed save says so. */
export function FastModeSwitch(props: { on: boolean; onChange(on: boolean): Promise<boolean> }) {
  const labelId = createUniqueId();
  const noteId = createUniqueId();
  const [failed, setFailed] = createSignal<"on" | "off" | null>(null);
  const [saving, setSaving] = createSignal(false);
  const toggle = async () => {
    if (saving()) return;
    setSaving(true);
    setFailed(null);
    const next = !props.on;
    try {
      if (!(await props.onChange(next))) setFailed(next ? "on" : "off");
    } finally {
      setSaving(false);
    }
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
    <div class="fast-mode-row">
      <span id={labelId}>{t("models.fastMode.label")}</span>
      <button
        type="button"
        role="switch"
        class="settings-switch fast-mode-switch"
        classList={{ "settings-switch-on": props.on }}
        aria-labelledby={labelId}
        aria-checked={props.on}
        aria-describedby={note() ? noteId : undefined}
        aria-busy={saving() || undefined}
        onClick={() => void toggle()}
      >
        <span />
      </button>
      <Show when={note()}>
        <p
          id={noteId}
          class={failed() ? "zb-kit-error" : "zb-kit-consequence"}
          role={failed() ? "alert" : undefined}
        >
          {note()}
        </p>
      </Show>
    </div>
  );
}

function providerAvailability(
  status: AgentStatus,
  models: AgentModelOption[],
  provider: AgentProviderId,
  providerName: (provider: AgentProviderId) => string,
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
    message: available ? null : `${providerName(provider)} is unavailable.`,
  };
}

function providerSummary(_provider: AgentProviderId, status: AgentProviderStatus): string {
  return status.message ?? providerStatusLabel(status.state);
}

function providerStatusLabel(state: AgentProviderStatus["state"]): string {
  if (state === "sign-in-required") return "Sign in required";
  if (state === "not-installed") return "Not installed";
  if (state === "outdated") return "Update required";
  if (state === "error") return "Unavailable";
  return "Checking";
}

function displayModelName(name: string | undefined, fallback: string): string {
  return name?.replace(/^[\s:–—-]+/, "") || fallback || "Default model";
}
