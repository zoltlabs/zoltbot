import { For, Show } from "solid-js";
import { employeeSummary, type SidebarEmployee } from "../tasks";
import { AgentAvatar } from "./AgentAvatar";
import { ChevronIcon } from "./SidebarIcons";

interface SidebarEmployeeRowProps {
  employee: SidebarEmployee;
  expanded: boolean;
  activeBotId: string;
  working: boolean;
  onToggle: () => void;
  onSelectBot: (botId: string) => void;
}

/**
 * An employee running several tasks at once: one row with its counts that expands to a row per
 * task chat. The row opens expanded while one of its task chats is on screen.
 */
export function SidebarEmployeeRow(props: SidebarEmployeeRowProps) {
  const first = () => props.employee.bots[0];
  const listId = () => `sidebar-employee-${props.employee.key.replace(/[^\w-]/g, "-")}`;
  const containsActive = () => props.employee.bots.some((bot) => bot.id === props.activeBotId);
  const open = () => props.expanded || containsActive();
  return (
    <div
      class="sidebar-employee"
      classList={{ "bot-row-nested": (first()?.depth ?? 0) > 0 }}
      style={{ "--bot-depth": String(Math.min(first()?.depth ?? 0, 4)) }}
    >
      <button
        type="button"
        class="bot-row sidebar-employee-row"
        aria-expanded={open()}
        aria-controls={listId()}
        onClick={props.onToggle}
      >
        <span class="bot-row-avatar">
          <AgentAvatar bot={first()} />
          <Show when={props.working}>
            <span class="bot-row-agent-status bot-row-agent-status-working" aria-hidden="true">
              <span class="bot-row-thinking-dots">
                <i />
                <i />
                <i />
              </span>
            </span>
          </Show>
        </span>
        <span class="bot-row-copy">
          <span class="bot-row-heading">
            <span class="bot-row-title">
              <strong>{props.employee.name}</strong>
              <em class="bot-row-role">Employee</em>
            </span>
            <ChevronIcon />
          </span>
          <span class="bot-row-preview">{employeeSummary(props.employee)}</span>
        </span>
      </button>
      <Show when={open()}>
        <ul
          id={listId()}
          class="sidebar-employee-tasks"
          aria-label={`${props.employee.name}'s tasks`}
        >
          <For each={props.employee.bots}>
            {(bot) => {
              const task = () => props.employee.tasks.get(bot.id);
              const queued = () => task()?.state === "queued";
              return (
                <li>
                  <button
                    type="button"
                    class="sidebar-task-row"
                    classList={{ "bot-row-active": props.activeBotId === bot.id }}
                    aria-pressed={props.activeBotId === bot.id}
                    onClick={() => props.onSelectBot(bot.id)}
                  >
                    <span
                      class="task-dot"
                      classList={{ "task-dot-running": !queued(), "task-dot-queued": queued() }}
                      aria-hidden="true"
                    />
                    <span class="sidebar-task-title">{task()?.title ?? bot.name}</span>
                    <span class="sidebar-task-meta">{queued() ? "Queued" : bot.time}</span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
