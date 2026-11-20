import { createMemo, Show } from "solid-js";
import type {
  AgentModelId,
  AgentModelOption,
  AgentProviderId,
  AgentProviderStatus,
  AgentStatus,
} from "../../../shared/ipc";
import { Combobox, ModelLogo, type PickerOption } from "../kit";

interface ProviderModelPickerProps {
  value: AgentModelId;
  modelOptions: AgentModelOption[];
  agentStatus: AgentStatus;
  variant?: "pill" | "field";
  ariaLabel?: string;
  label?: string;
  disabled?: boolean;
  /** Why the picker is disabled, shown on hover. */
  disabledReason?: string;
  onChange: (model: AgentModelId) => void;
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

  const options = createMemo((): PickerOption<AgentModelId>[] =>
    props.modelOptions.map((model) => {
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
    }),
  );
  const field = () => props.variant === "field";

  return (
    <span
      class="provider-model-picker"
      classList={{ "provider-model-picker-field": field() }}
      title={props.disabled ? props.disabledReason : undefined}
    >
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
        placeholder={displayModelName(undefined, props.value)}
        class={field() ? "provider-model-trigger-field" : "provider-model-trigger-pill"}
        onChange={props.onChange}
      />
    </span>
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
