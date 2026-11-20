import { createMemo, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import type { AgentModelId, AgentModelOption, AgentStatus } from "../../../../shared/ipc";
import type { BotProfile } from "../../data";
import { Suggestions } from "../../kit";
import { AgentAvatar } from "../AgentAvatar";
import { OrganizationIcon } from "../OrganizationPanel";
import { ProviderModelPicker } from "../ProviderModelPicker";
import { SidebarToggleIcon } from "../Sidebar";
import { ContextBar, ContextMeter } from "./ContextMeter";
import { createContextUsage } from "./context";
import { ComputerIcon, PlusIcon } from "./icons";

export function ConversationHeader(props: {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebar: () => void;
  agentPickerOpen: boolean;
  bot: BotProfile | undefined;
  bots: BotProfile[];
  creatingAgent: boolean;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onCloseAgentPicker: () => void;
  onOpenSettings: () => void;
  modelValue: AgentModelId;
  modelOptions: AgentModelOption[];
  agentStatus: AgentStatus;
  modelDisabled: boolean;
  working: boolean;
  onModelChange: (model: AgentModelId) => void;
  organizationOpen: boolean;
  onToggleOrganization: () => void;
  browserControlled: boolean;
  browserControllerName: string | undefined;
  screenOpen: boolean;
  onToggleScreen: () => void;
}) {
  const context = createContextUsage(() => props.bot?.id);
  return (
    <>
      <header class="window-drag conversation-header">
        <Show when={props.leftSidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label="Show sidebar"
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title="Show sidebar"
            onClick={props.onToggleLeftSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <Show
          when={props.agentPickerOpen}
          fallback={
            <>
              <Show when={props.bot}>
                {(bot) => (
                  <button
                    type="button"
                    class="conversation-title no-drag"
                    aria-label="View agent settings"
                    onClick={() => {
                      props.onOpenSettings();
                    }}
                  >
                    <AgentAvatar bot={bot()} />
                    <h1>{bot().name}</h1>
                  </button>
                )}
              </Show>
              <div class="conversation-header-actions no-drag">
                <ContextMeter context={context} />
                <Show when={props.bot}>
                  <ProviderModelPicker
                    value={props.modelValue}
                    modelOptions={props.modelOptions}
                    agentStatus={props.agentStatus}
                    disabled={props.modelDisabled}
                    disabledReason={
                      props.working
                        ? "Wait for the current work to finish before changing models."
                        : "Models appear once a coding agent is set up."
                    }
                    onChange={props.onModelChange}
                  />
                </Show>
                <Show when={props.bot?.projectId}>
                  <button
                    type="button"
                    class="header-panel-toggle computer-button"
                    aria-label="Organization"
                    aria-controls="organization-side-panel"
                    aria-expanded={props.organizationOpen}
                    onClick={() => props.onToggleOrganization()}
                  >
                    <OrganizationIcon />
                  </button>
                </Show>
                <button
                  type="button"
                  class="header-panel-toggle computer-button"
                  classList={{ "computer-button-agent-active": props.browserControlled }}
                  aria-label={
                    props.browserControlled
                      ? `${props.browserControllerName ?? "Agent"} is controlling the browser`
                      : props.screenOpen
                        ? "Hide computer"
                        : "Open computer"
                  }
                  aria-expanded={props.screenOpen}
                  onClick={props.onToggleScreen}
                >
                  <ComputerIcon />
                  <Show when={props.browserControlled}>
                    <span class="computer-control-dot" aria-hidden="true" />
                  </Show>
                </button>
              </div>
            </>
          }
        >
          <AgentPicker
            bots={props.bots}
            creatingAgent={props.creatingAgent}
            onCreateAgent={props.onCreateAgent}
            onSelectAgent={props.onSelectAgent}
            onClose={props.onCloseAgentPicker}
          />
        </Show>
      </header>
      <Show when={!props.agentPickerOpen}>
        <ContextBar context={context} bot={props.bot} onSelectAgent={props.onSelectAgent} />
      </Show>
    </>
  );
}

function AgentPicker(props: {
  bots: BotProfile[];
  creatingAgent: boolean;
  onCreateAgent: () => void;
  onSelectAgent: (botId: string) => void;
  onClose: () => void;
}) {
  const [pickerQuery, setPickerQuery] = createSignal("");
  const [activePickerOption, setActivePickerOption] = createSignal(0);
  let pickerInput: HTMLInputElement | undefined;
  const [field, setField] = createSignal<HTMLLabelElement>();
  const listId = createUniqueId();
  const optionId = (index: number) => `${listId}-${index}`;
  const filteredBots = createMemo(() => {
    const query = pickerQuery().trim().toLowerCase();
    return query
      ? props.bots.filter((bot) => `${bot.name} ${bot.role}`.toLowerCase().includes(query))
      : props.bots;
  });

  onMount(() => requestAnimationFrame(() => pickerInput?.focus()));

  function handleKeyDown(event: KeyboardEvent) {
    const optionCount = filteredBots().length + 1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActivePickerOption((current) => (current + 1) % optionCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActivePickerOption((current) => (current - 1 + optionCount) % optionCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const bot = filteredBots()[activePickerOption() - 1];
      if (activePickerOption() === 0) props.onCreateAgent();
      else if (bot) props.onSelectAgent(bot.id);
    } else if (event.key === "Escape") props.onClose();
  }

  return (
    <div class="agent-picker-root no-drag">
      <label ref={setField} class="agent-recipient-field">
        <span>To:</span>
        <input
          ref={(element) => (pickerInput = element)}
          role="combobox"
          aria-label="To:"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={optionId(activePickerOption())}
          placeholder="Search or create agents"
          value={pickerQuery()}
          onInput={(event) => {
            setPickerQuery(event.currentTarget.value);
            setActivePickerOption(0);
          }}
          onKeyDown={handleKeyDown}
        />
      </label>
      <Show when={field()}>
        {(anchor) => (
          <Suggestions anchor={anchor()} placement="bottom-start" matchWidth>
            <div id={listId} class="agent-picker-menu" role="listbox" aria-label="Agents">
              <button
                type="button"
                id={optionId(0)}
                tabIndex={-1}
                role="option"
                aria-selected={activePickerOption() === 0}
                class="agent-picker-option agent-picker-create"
                disabled={props.creatingAgent}
                onPointerDown={(event) => event.preventDefault()}
                onClick={props.onCreateAgent}
              >
                <span class="agent-picker-plus">
                  <PlusIcon />
                </span>
                <span>{props.creatingAgent ? "Creating agent…" : "Create new agent"}</span>
              </button>
              <For each={filteredBots()}>
                {(bot, index) => (
                  <button
                    type="button"
                    id={optionId(index() + 1)}
                    tabIndex={-1}
                    role="option"
                    aria-selected={activePickerOption() === index() + 1}
                    class="agent-picker-option"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => props.onSelectAgent(bot.id)}
                  >
                    <AgentAvatar bot={bot} />
                    <span>{bot.name}</span>
                  </button>
                )}
              </For>
            </div>
          </Suggestions>
        )}
      </Show>
    </div>
  );
}
