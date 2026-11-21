import { type Accessor, createSignal, For, Show } from "solid-js";
import type {
  AgentModelId,
  AgentModelOption,
  AgentReasoningEffort,
  AgentStatus,
  BotAvatarColor,
  BotAvatarShape,
  UpdateBotInput,
} from "../../../../shared/ipc";
import type { BotProfile } from "../../data";
import { AVATAR_COLORS, AVATAR_SHAPES } from "../../data";
import { t } from "../../i18n";
import { Select } from "../../kit";
import { AgentAvatar } from "../AgentAvatar";
import { PanelResizer } from "../PanelResizer";
import { ProviderModelPicker } from "../ProviderModelPicker";
import { AgentUsage } from "./AgentUsage";
import {
  AVATAR_COLOR_LABELS,
  AVATAR_SHAPE_LABELS,
  CONVERSATION_PANEL_MIN,
  SETTINGS_PANEL_DEFAULT,
  SETTINGS_PANEL_MAX,
  SETTINGS_PANEL_MIN,
} from "./constants";
import { BackIcon, CloseIcon } from "./icons";
import { CoAuthorLine } from "./CoAuthorLine";
import { RepositoryMode } from "./RepositoryMode";
import "./talking-style.css";

/** A2: the styles in the order the menu lists them. */
const talkingStyles = () => [
  { value: "neutral" as const, label: t("agent.style.neutral") },
  { value: "warm" as const, label: t("agent.style.warm") },
  { value: "casual" as const, label: t("agent.style.casual") },
  { value: "direct" as const, label: t("agent.style.direct") },
];

/** Editable copies of the agent's profile fields, refreshed when the agent changes. */
export function createAgentSettingsForm() {
  const [name, setName] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [notifications, setNotifications] = createSignal(true);
  const [avatarPickerOpen, setAvatarPickerOpen] = createSignal(false);
  const [avatarShape, setAvatarShape] = createSignal<BotAvatarShape>("blob");
  const [avatarColor, setAvatarColor] = createSignal<BotAvatarColor>("orange");
  return {
    name,
    setName,
    title,
    setTitle,
    description,
    setDescription,
    notifications,
    setNotifications,
    avatarPickerOpen,
    setAvatarPickerOpen,
    avatarShape,
    setAvatarShape,
    avatarColor,
    setAvatarColor,
  };
}

export type AgentSettingsForm = ReturnType<typeof createAgentSettingsForm>;

export function AgentSettings(props: {
  form: AgentSettingsForm;
  bot: BotProfile | undefined;
  width: number;
  containerWidth: Accessor<number>;
  onResize: (width: number) => void;
  onResizeEnd: (width: number) => void;
  onClose: () => void;
  save: (updates: Omit<UpdateBotInput, "botId">) => Promise<boolean>;
  modelValue: AgentModelId;
  agentStatus: AgentStatus;
  modelOptions: AgentModelOption[];
  modelDisabled: boolean;
  working: boolean;
  onModelChange: (model: AgentModelId) => void;
  reasoning: AgentReasoningEffort;
  reasoningOptions: AgentReasoningEffort[];
  onReasoningChange: (effort: AgentReasoningEffort) => void;
  saveError: string | null;
  /** Opens the Memory page filtered to this agent (S5). */
  onOpenMemory?: (() => void) | undefined;
}) {
  const form = props.form;
  return (
    <aside id="settings-side-panel" class="agent-settings-panel" aria-label="Agent settings">
      <PanelResizer
        class="right-panel-resizer"
        label="Resize right panel"
        controls="settings-side-panel"
        direction="right"
        value={props.width}
        defaultValue={SETTINGS_PANEL_DEFAULT}
        min={SETTINGS_PANEL_MIN}
        max={() =>
          Math.min(
            SETTINGS_PANEL_MAX,
            Math.max(SETTINGS_PANEL_MIN, props.containerWidth() - CONVERSATION_PANEL_MIN),
          )
        }
        onResize={props.onResize}
        onResizeEnd={props.onResizeEnd}
      />
      <header class="agent-settings-header">
        <button
          type="button"
          class="agent-settings-nav-button"
          aria-label="Back to details"
          onClick={props.onClose}
        >
          <BackIcon />
        </button>
        <h2>Settings</h2>
        <button
          type="button"
          class="agent-settings-nav-button"
          aria-label="Close details"
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div class="agent-settings-content">
        <button
          type="button"
          class="agent-settings-avatar"
          aria-label="Edit agent avatar"
          aria-expanded={form.avatarPickerOpen()}
          onClick={() => form.setAvatarPickerOpen((open) => !open)}
        >
          <AgentAvatar shape={form.avatarShape()} color={form.avatarColor()} bot={props.bot} />
        </button>
        <Show when={form.avatarPickerOpen()}>
          <section class="avatar-editor" aria-label="Avatar editor">
            <fieldset class="avatar-shape-grid" aria-label="Character shape">
              <For each={AVATAR_SHAPES}>
                {(shape) => (
                  <button
                    type="button"
                    class="avatar-shape-choice"
                    classList={{ "avatar-choice-selected": form.avatarShape() === shape }}
                    aria-label={`${AVATAR_SHAPE_LABELS[shape]} character shape`}
                    aria-pressed={form.avatarShape() === shape}
                    onClick={() => {
                      form.setAvatarShape(shape);
                      props.save({ avatarShape: shape });
                    }}
                  >
                    <AgentAvatar shape={shape} color={form.avatarColor()} bot={props.bot} />
                  </button>
                )}
              </For>
            </fieldset>
            <div class="avatar-editor-divider" />
            <fieldset class="avatar-color-grid" aria-label="Character color">
              <For each={AVATAR_COLORS}>
                {(color) => (
                  <button
                    type="button"
                    class="avatar-color-choice"
                    classList={{ "avatar-choice-selected": form.avatarColor() === color }}
                    aria-label={`${AVATAR_COLOR_LABELS[color]} character color`}
                    aria-pressed={form.avatarColor() === color}
                    onClick={() => {
                      form.setAvatarColor(color);
                      props.save({ avatarColor: color });
                    }}
                  >
                    <span class={`avatar-color-swatch avatar-color-swatch-${color}`} />
                  </button>
                )}
              </For>
            </fieldset>
          </section>
        </Show>
        <label class="agent-settings-field">
          <span>Name</span>
          <input
            value={form.name()}
            aria-label="Agent name"
            onInput={(event) => form.setName(event.currentTarget.value)}
            onBlur={() => props.save({ name: form.name().trim() || "New agent" })}
          />
        </label>
        <label class="agent-settings-field">
          <span>Title</span>
          <input
            value={form.title()}
            aria-label="Agent title"
            placeholder="Describe what your agent does"
            onInput={(event) => form.setTitle(event.currentTarget.value)}
            onBlur={() => props.save({ role: form.title().trim() })}
          />
        </label>
        <label class="agent-settings-field agent-settings-description">
          <span>Description</span>
          <textarea
            rows="4"
            value={form.description()}
            aria-label="Agent description"
            placeholder="What this agent is for"
            onInput={(event) => form.setDescription(event.currentTarget.value)}
            onBlur={() => props.save({ description: form.description() })}
          />
        </label>
        <section class="agent-settings-model" aria-labelledby="agent-model-heading">
          <div class="agent-settings-section-heading">
            <strong id="agent-model-heading">Runtime</strong>
          </div>
          <div class="agent-settings-model-controls">
            <div class="agent-settings-model-option">
              <ProviderModelPicker
                variant="field"
                ariaLabel="Agent model"
                value={props.modelValue}
                agentStatus={props.agentStatus}
                modelOptions={props.modelOptions}
                disabled={props.modelDisabled}
                disabledReason={
                  props.working
                    ? "Wait for the current work to finish before changing models."
                    : "Models appear once a coding agent is set up."
                }
                onChange={props.onModelChange}
              />
            </div>
            <div class="agent-settings-model-row agent-settings-thinking-row">
              <span aria-hidden="true">Reasoning</span>
              <Select
                label="Agent reasoning level"
                value={props.reasoning}
                options={props.reasoningOptions.map((effort) => ({
                  value: effort,
                  label: reasoningLabel(effort),
                }))}
                onChange={props.onReasoningChange}
              />
            </div>
          </div>
        </section>
        <Show when={props.saveError}>
          {(message) => (
            <p class="agent-settings-save-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <div class="agent-settings-notifications">
          <strong id="agent-notifications-label">
            Notify when {form.name().trim() || "this agent"} replies
          </strong>
          <button
            type="button"
            role="switch"
            class="settings-switch"
            classList={{ "settings-switch-on": form.notifications() }}
            aria-labelledby="agent-notifications-label"
            aria-checked={form.notifications()}
            onClick={() => {
              const next = !form.notifications();
              form.setNotifications(next);
              props.save({ notifications: next });
            }}
          >
            <span />
          </button>
        </div>
        <div class="agent-settings-model-row agent-settings-context-row">
          <span aria-hidden="true">{t("agent.contextFull.label")}</span>
          <Select
            label={t("agent.contextFull.label")}
            value={props.bot?.contextFull ?? "ask"}
            options={[
              { value: "compact" as const, label: t("agent.contextFull.compact") },
              { value: "ask" as const, label: t("agent.contextFull.ask") },
            ]}
            onChange={(value) => void props.save({ contextFull: value })}
          />
        </div>
        <div class="agent-settings-model-row agent-settings-context-row">
          <span aria-hidden="true">{t("agent.style.label")}</span>
          <Select
            label={t("agent.style.label")}
            describedBy="agent-style-note"
            value={props.bot?.talkingStyle ?? "neutral"}
            options={talkingStyles()}
            onChange={(value) => void props.save({ talkingStyle: value })}
          />
        </div>
        <p id="agent-style-note" class="agent-settings-note">
          {t("agent.style.note")}
        </p>
        <Show when={props.onOpenMemory}>
          <div class="agent-settings-model-row agent-settings-context-row">
            <span id="agent-memory-label">{t("memory.title")}</span>
            <button
              type="button"
              id="agent-memory-open"
              class="zb-kit-button"
              aria-labelledby="agent-memory-open agent-memory-label"
              onClick={() => props.onOpenMemory?.()}
            >
              {t("memory.agent.open")}
            </button>
          </div>
        </Show>
        <Show when={props.bot?.id}>{(botId) => <AgentUsage botId={botId()} />}</Show>
        <Show when={props.bot?.id}>{(botId) => <RepositoryMode botId={botId()} />}</Show>
        <Show when={props.bot?.id}>{(botId) => <CoAuthorLine botId={botId()} />}</Show>
      </div>
    </aside>
  );
}

export function reasoningLabel(effort: AgentReasoningEffort): string {
  if (effort === "xhigh") return "Extra high";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}
