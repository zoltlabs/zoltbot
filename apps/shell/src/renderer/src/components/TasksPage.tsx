import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { TaskSummary } from "../../../shared/tasks";
import type { BotProfile } from "../data";
import { groupTasks, statusLabel, TASK_GROUPS, type TaskGroup, taskAge } from "../tasks";
import type { TasksStore } from "../tasks-store";
import { AgentAvatar } from "./AgentAvatar";
import { SidebarToggleIcon } from "./SidebarIcons";

interface TasksPageProps {
  store: TasksStore;
  bots: BotProfile[];
  /** The project to show first; null shows every project. */
  projectId: string | null;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  onOpenChat: (botId: string) => void;
}

const ALL = "";

/**
 * Every task in one place, in place of the conversation: what needs the person, what runs, what
 * waits and what's done. Accept and Send back move the row at once.
 */
export function TasksPage(props: TasksPageProps) {
  const [project, setProject] = createSignal(props.projectId ?? ALL);
  const [team, setTeam] = createSignal(ALL);
  const [owner, setOwner] = createSignal(ALL);
  const [showDone, setShowDone] = createSignal(false);
  const [sendingBack, setSendingBack] = createSignal<string | null>(null);
  const [feedback, setFeedback] = createSignal("");
  const [announcement, setAnnouncement] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  let heading: HTMLHeadingElement | undefined;
  let list: HTMLDivElement | undefined;

  createEffect(
    on(
      () => props.projectId,
      (projectId) => {
        setProject(projectId ?? ALL);
        setTeam(ALL);
        setOwner(ALL);
      },
      { defer: true },
    ),
  );
  onMount(() => {
    heading?.focus();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(timer));
  });

  const projects = createMemo(() =>
    options(
      props.store.tasks(),
      (task) => task.projectId,
      (task) => task.projectName,
    ),
  );
  const inProject = createMemo(() =>
    props.store.tasks().filter((task) => !project() || task.projectId === project()),
  );
  const teams = createMemo(() =>
    options(
      inProject(),
      (task) => task.teamId,
      (task) => task.teamName,
    ),
  );
  const owners = createMemo(() =>
    options(
      inProject(),
      (task) => task.owner?.profileId ?? null,
      (task) => task.owner?.name ?? "",
    ),
  );
  const visible = createMemo(() =>
    inProject().filter(
      (task) =>
        (!team() || task.teamId === team()) && (!owner() || task.owner?.profileId === owner()),
    ),
  );
  const groups = createMemo(() => groupTasks(visible()));
  const projectName = createMemo(
    () => projects().find((option) => option.id === project())?.name ?? "",
  );
  const botFor = (task: TaskSummary) => props.bots.find((bot) => bot.id === task.threadId);

  /** Keeps keyboard focus in the list when the row it was on moves to another group. */
  function keepFocus(taskId: string) {
    const rows = [...(list?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])];
    const index = rows.findIndex((row) => row.dataset.taskId === taskId);
    const neighbour = rows[index + 1] ?? rows[index - 1];
    requestAnimationFrame(() => {
      const target = neighbour?.isConnected
        ? neighbour.querySelector<HTMLElement>(".task-row-open")
        : null;
      (target ?? heading)?.focus();
    });
  }

  function accept(task: TaskSummary) {
    keepFocus(task.id);
    setAnnouncement(`Accepted ${task.title}.`);
    void props.store.review(task, "accept");
  }

  function sendBack(task: TaskSummary, event: SubmitEvent) {
    event.preventDefault();
    const text = feedback().trim();
    if (!text) return;
    keepFocus(task.id);
    setSendingBack(null);
    setFeedback("");
    setAnnouncement(`Sent back ${task.title}.`);
    void props.store.review(task, "changes", text);
  }

  return (
    <main aria-label="Tasks" class="map-panel tasks-panel">
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
        <h1 ref={heading} class="map-title tasks-title" tabIndex={-1}>
          {projectName() ? `Tasks · ${projectName()}` : "Tasks"}
        </h1>
      </header>
      <div class="tasks-body">
        <div class="tasks-filters no-drag">
          <Show when={projects().length > 1}>
            <Filter
              label="Project"
              value={project()}
              all="All projects"
              options={projects()}
              onChange={(value) => {
                setProject(value);
                setTeam(ALL);
                setOwner(ALL);
              }}
            />
          </Show>
          <Filter
            label="Team"
            value={team()}
            all="All teams"
            options={teams()}
            onChange={setTeam}
          />
          <Filter
            label="Owner"
            value={owner()}
            all="Anyone"
            options={owners()}
            onChange={setOwner}
          />
        </div>
        <Show when={props.store.error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <output class="sr-only">{announcement()}</output>
        <Show
          when={visible().length > 0}
          fallback={
            <p class="tasks-empty">
              {props.store.tasks().length
                ? "No tasks match these filters."
                : "No tasks yet. When a manager assigns work, it shows up here."}
            </p>
          }
        >
          <div ref={list} class="tasks-groups">
            <For each={TASK_GROUPS}>
              {(group) => (
                <Show when={groups()[group.id].length > 0}>
                  <section class="tasks-group" aria-labelledby={`tasks-group-${group.id}`}>
                    <div class="tasks-group-heading">
                      <h2 id={`tasks-group-${group.id}`}>
                        {group.title}
                        <span class="tasks-group-count"> · {groups()[group.id].length}</span>
                      </h2>
                      <Show when={group.id === "done"}>
                        <button
                          type="button"
                          class="tasks-link"
                          aria-expanded={showDone()}
                          aria-controls="tasks-done-list"
                          onClick={() => setShowDone(!showDone())}
                        >
                          {showDone() ? "Hide" : "Show"}
                        </button>
                      </Show>
                    </div>
                    <Show when={group.id !== "done" || showDone()}>
                      <ul
                        class="tasks-list"
                        id={group.id === "done" ? "tasks-done-list" : undefined}
                      >
                        <For each={groups()[group.id]}>
                          {(task) => (
                            <TaskRow
                              task={task}
                              group={group.id}
                              bot={botFor(task)}
                              now={now()}
                              sendingBack={sendingBack() === task.id}
                              feedback={feedback()}
                              onOpen={() => task.threadId && props.onOpenChat(task.threadId)}
                              onAccept={() => accept(task)}
                              onStartSendBack={() => {
                                setFeedback("");
                                setSendingBack(task.id);
                              }}
                              onCancelSendBack={() => setSendingBack(null)}
                              onFeedback={setFeedback}
                              onSendBack={(event) => sendBack(task, event)}
                            />
                          )}
                        </For>
                      </ul>
                    </Show>
                  </section>
                </Show>
              )}
            </For>
          </div>
        </Show>
      </div>
    </main>
  );
}

interface TaskRowProps {
  task: TaskSummary;
  group: TaskGroup;
  bot: BotProfile | undefined;
  now: number;
  sendingBack: boolean;
  feedback: string;
  onOpen: () => void;
  onAccept: () => void;
  onStartSendBack: () => void;
  onCancelSendBack: () => void;
  onFeedback: (value: string) => void;
  onSendBack: (event: SubmitEvent) => void;
}

function TaskRow(props: TaskRowProps) {
  const feedbackId = () => `task-feedback-${props.task.id.replace(/[^\w-]/g, "-")}`;
  const owner = () =>
    [props.task.owner?.name, props.task.teamName].filter(Boolean).join(" · ") || "No owner";
  return (
    <li class="task-row" data-task-id={props.task.id} data-state={props.task.state}>
      <button
        type="button"
        class="task-row-open"
        disabled={!props.task.threadId}
        onClick={props.onOpen}
      >
        <span class={`task-dot task-dot-${dotOf(props.task)}`} aria-hidden="true" />
        <span class="task-row-title">{props.task.title}</span>
        <span class="task-row-owner">
          <AgentAvatar bot={props.bot} class="task-row-avatar" />
          <span>{owner()}</span>
        </span>
        <span class={`task-status task-status-${dotOf(props.task)}`}>
          {statusLabel(props.task)}
        </span>
        <span class="task-row-age">
          <time dateTime={props.task.createdAt}>{taskAge(props.task.createdAt, props.now)}</time>
        </span>
      </button>
      <Show when={props.task.state === "review" && !props.sendingBack}>
        <div class="task-row-actions">
          <button
            type="button"
            class="task-button task-button-primary"
            aria-label={`Accept ${props.task.title}`}
            onClick={props.onAccept}
          >
            Accept
          </button>
          <button
            type="button"
            class="task-button"
            aria-label={`Send back ${props.task.title}`}
            onClick={props.onStartSendBack}
          >
            Send back
          </button>
        </div>
      </Show>
      <Show when={props.sendingBack}>
        <form class="task-feedback" onSubmit={props.onSendBack}>
          <label for={feedbackId()}>What should change?</label>
          <textarea
            ref={(element) => requestAnimationFrame(() => element.focus())}
            id={feedbackId()}
            rows={2}
            maxLength={2000}
            value={props.feedback}
            onInput={(event) => props.onFeedback(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancelSendBack();
              }
            }}
          />
          <div class="task-row-actions">
            <button type="button" class="task-button" onClick={props.onCancelSendBack}>
              Cancel
            </button>
            <button
              type="submit"
              class="task-button task-button-primary"
              disabled={!props.feedback.trim()}
            >
              Send back
            </button>
          </div>
        </form>
      </Show>
    </li>
  );
}

function Filter(props: {
  label: string;
  value: string;
  all: string;
  options: { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label class="tasks-filter">
      <span class="sr-only">{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value)}>
        <option value={ALL}>{props.all}</option>
        <For each={props.options}>
          {(option) => <option value={option.id}>{option.name}</option>}
        </For>
      </select>
    </label>
  );
}

/** The distinct values tasks have for a filter, sorted by name. */
function options(
  tasks: readonly TaskSummary[],
  id: (task: TaskSummary) => string | null,
  name: (task: TaskSummary) => string,
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const task of tasks) {
    const key = id(task);
    if (key && !seen.has(key)) seen.set(key, name(task) || "Untitled");
  }
  return [...seen]
    .map(([key, value]) => ({ id: key, name: value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dotOf(task: TaskSummary): "review" | "failed" | "running" | "waiting" | "queued" | "done" {
  if (task.state === "review") return "review";
  if (task.state === "failed") return "failed";
  if (task.state === "running") return "running";
  if (task.state === "blocked") return "waiting";
  if (task.state === "queued") return "queued";
  return "done";
}
