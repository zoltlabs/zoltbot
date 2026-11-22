import {
  type Interaction,
  InteractionSchema,
  ProjectSchema,
  parse,
  type Task,
  TaskSchema,
} from "@zoltbot/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { CloudDesktopApi, CloudWorkspace } from "../../../../shared/cloud";
import { Cluster, EmptyState, Field, Select, Stack } from "../../kit";
import { CloudPanel } from "./CloudPanel";
import { CloudTask } from "./CloudTask";

const locations = [
  { value: "sandbox", label: "Cloud sandbox" },
  { value: "mac", label: "This Mac" },
] as const;
function parsed<T>(rows: Record<string, unknown>[], decode: (row: unknown) => T) {
  return rows.flatMap((row) => {
    try {
      return [decode(row)];
    } catch {
      return [];
    }
  });
}

export function CloudProjects(props: {
  api: CloudDesktopApi;
  workspace: CloudWorkspace;
  projectId: string | undefined;
  onOpenProject(id: string): void;
  onOpenLink(url: string): void;
  sidebarCollapsed: boolean;
  onShowSidebar(): void;
}) {
  const entities = () => props.workspace.state.snapshot.entities;
  const project = createMemo(() =>
    parsed(entities().project ?? [], (row) => parse(ProjectSchema, row)).find(
      (row) => row.id === props.projectId && row.cloud,
    ),
  );
  const localTasks = createMemo(() =>
    parsed(entities().task ?? [], (row) => parse(TaskSchema, row)).filter(
      (task) => task.projectId === props.projectId,
    ),
  );
  const interactions = (): Interaction[] =>
    parsed(entities().interaction ?? [], (row) => parse(InteractionSchema, row));
  const profiles = () =>
    (entities().agent ?? []).flatMap((row) =>
      typeof row.id === "string" && typeof row.name === "string"
        ? [{ value: row.id, label: row.name }]
        : [],
    );
  const [creatingTask, setCreatingTask] = createSignal(false);
  const [selected, setSelected] = createSignal<{ projectId: string; taskId: string }>();
  const [location, setLocation] = createSignal<"sandbox" | "mac">("sandbox");
  const [profile, setProfile] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const currentTask = (): Task | undefined => {
    const task = selected();
    return task?.projectId === props.projectId
      ? localTasks().find((row) => row.id === task?.taskId)
      : undefined;
  };
  const mutate = async (event: SubmitEvent, type: "project" | "task") => {
    event.preventDefault();
    if (busy() || props.workspace.readOnly || !(event.currentTarget instanceof HTMLFormElement))
      return;
    const data = new FormData(event.currentTarget);
    const read = (field: string) => String(data.get(field) ?? "").trim();
    const owner = props.workspace.owner;
    const activeProject = props.projectId;
    setBusy(true);
    setError("");
    try {
      if (type === "project") {
        if (!read("name") || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(read("repository"))) {
          setError("Enter a project name and a repository in owner/repo format.");
          return;
        }
        const result = parse(
          ProjectSchema,
          await props.api.call(
            owner,
            "cloud.project.create",
            {
              name: read("name"),
              repository: read("repository"),
              defaultBranch: "main",
              setupScript: read("setupScript"),
            },
            crypto.randomUUID(),
          ),
        );
        if (
          owner.sessionId === props.workspace.owner.sessionId &&
          activeProject === props.projectId
        )
          props.onOpenProject(result.id);
      } else if (activeProject) {
        const profileId = profile() ?? profiles()[0]?.value;
        if (!read("title") || !read("brief") || !profileId) {
          setError("Enter a title and brief and choose an agent.");
          return;
        }
        const task = parse(
          TaskSchema,
          await props.api.call(
            owner,
            "task.create",
            {
              title: read("title"),
              brief: read("brief"),
              profileId,
              node: { type: "project", id: activeProject },
              location: location(),
            },
            crypto.randomUUID(),
          ),
        );
        if (
          owner.sessionId === props.workspace.owner.sessionId &&
          activeProject === props.projectId
        ) {
          setSelected({ projectId: activeProject, taskId: task.id });
          setCreatingTask(false);
        }
      }
    } catch {
      setError(
        type === "project"
          ? "Couldn’t create the Cloud project. Try again."
          : "Couldn’t create the task. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <CloudPanel
      title={project()?.name ?? (props.projectId ? props.workspace.name : "New Cloud project")}
      sidebarCollapsed={props.sidebarCollapsed}
      onShowSidebar={props.onShowSidebar}
    >
      <Stack gap={6}>
        <Show when={props.workspace.readOnly}>
          <p role="status">Cloud is offline. You can read the last synced state.</p>
        </Show>
        <Show when={error()}>
          <p role="alert" class="models-error">
            {error()}
          </p>
        </Show>
        <Show when={!props.projectId}>
          <form onSubmit={(event) => void mutate(event, "project")}>
            <Stack gap={4}>
              <Field
                label="Project name"
                input={(id) => (
                  <input id={id} name="name" maxLength="150" class="models-limit-input" />
                )}
              />
              <Field
                label="GitHub repository"
                input={(id) => (
                  <input
                    id={id}
                    name="repository"
                    maxLength="200"
                    placeholder="owner/repo"
                    spellcheck={false}
                    class="models-limit-input"
                  />
                )}
              />
              <Field
                label="Setup script"
                input={(id) => (
                  <textarea
                    id={id}
                    name="setupScript"
                    maxLength="64000"
                    rows={5}
                    spellcheck={false}
                    class="models-limit-input"
                  />
                )}
              />
              <Cluster>
                <button
                  type="submit"
                  class="models-button models-button-primary"
                  disabled={busy() || props.workspace.readOnly}
                >
                  Create project
                </button>
              </Cluster>
            </Stack>
          </form>
        </Show>
        <Show when={project()}>
          {(current) => (
            <>
              <p>{current().cloud?.repository}</p>
              <Cluster>
                <button
                  type="button"
                  class="models-button"
                  disabled={props.workspace.readOnly}
                  onClick={() => setCreatingTask((open) => !open)}
                >
                  {creatingTask() ? "Cancel new task" : "New task"}
                </button>
              </Cluster>
              <Show when={creatingTask()}>
                <form onSubmit={(event) => void mutate(event, "task")}>
                  <Stack gap={4}>
                    <Field
                      label="Title"
                      input={(id) => (
                        <input id={id} name="title" maxLength="150" class="models-limit-input" />
                      )}
                    />
                    <Field
                      label="Task brief"
                      input={(id) => (
                        <textarea
                          id={id}
                          name="brief"
                          maxLength="4000"
                          rows={4}
                          class="models-limit-input"
                        />
                      )}
                    />
                    <Field
                      label="Agent"
                      input={(id) => (
                        <Select
                          id={id}
                          label="Agent"
                          options={profiles()}
                          value={profile() ?? profiles()[0]?.value ?? null}
                          onChange={setProfile}
                        />
                      )}
                    />
                    <Field
                      label="Run on"
                      input={(id) => (
                        <Select<"sandbox" | "mac">
                          id={id}
                          label="Run on"
                          options={locations}
                          value={location()}
                          onChange={setLocation}
                        />
                      )}
                    />
                    <Cluster>
                      <button
                        type="submit"
                        class="models-button models-button-primary"
                        disabled={busy() || props.workspace.readOnly}
                      >
                        Create task
                      </button>
                    </Cluster>
                  </Stack>
                </form>
              </Show>
              <Show when={localTasks().length} fallback={<EmptyState title="No tasks yet" />}>
                <ul class="models-list">
                  <For each={localTasks()}>
                    {(task) => (
                      <li class="models-row">
                        <button
                          type="button"
                          class="models-link"
                          aria-pressed={currentTask()?.id === task.id}
                          onClick={() => setSelected({ projectId: current().id, taskId: task.id })}
                        >
                          {task.title}
                        </button>
                        <span>{task.location === "mac" ? "This Mac" : "Cloud sandbox"}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <For each={currentTask() ? [currentTask()?.id] : []}>
                {(id) => (
                  <Show when={localTasks().find((task) => task.id === id)}>
                    {(task) => (
                      <CloudTask
                        task={task}
                        interactions={interactions().filter(
                          (item) => item.taskId === id && item.state === "pending",
                        )}
                        workspace={props.workspace}
                        api={props.api}
                        onOpenLink={props.onOpenLink}
                      />
                    )}
                  </Show>
                )}
              </For>
            </>
          )}
        </Show>
      </Stack>
    </CloudPanel>
  );
}
