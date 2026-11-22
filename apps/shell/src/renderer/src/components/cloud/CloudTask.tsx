import {
  type Interaction,
  type ItemSchema,
  methodCatalog,
  parse,
  type Task,
} from "@zoltbot/protocol";
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { CloudAnswer, CloudDesktopApi, CloudWorkspace } from "../../../../shared/cloud";
import { Cluster, ConfirmDialog, Field, Stack } from "../../kit";

type Item = ReturnType<typeof parse<typeof ItemSchema>>;

export function CloudTask(props: {
  task(): Task;
  interactions: Interaction[];
  workspace: CloudWorkspace;
  api: CloudDesktopApi;
  onOpenLink(url: string): void;
}) {
  const [items, setItems] = createSignal<Item[]>([]);
  const [patch, setPatch] = createSignal("");
  const [fingerprint, setFingerprint] = createSignal("");
  const [pullRequest, setPullRequest] = createSignal<string>();
  const [feedback, setFeedback] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let reading = false;
  let readAgain = false;
  let alive = true;
  onCleanup(() => {
    alive = false;
  });

  const rpc = (method: string, params: unknown, commandId?: string) =>
    props.api.call(props.workspace.owner, method, params, commandId);
  async function read() {
    if (props.workspace.readOnly) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      do {
        readAgain = false;
        const list: Item[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page++) {
          const result = parse(
            methodCatalog["thread.history"].result,
            await rpc("thread.history", {
              threadId: props.task().threadId,
              ...(cursor ? { cursor } : {}),
              limit: 200,
            }),
          );
          list.push(...result.items);
          if (!result.cursor) break;
          cursor = result.cursor;
        }
        if (alive) setItems(list);
        if (props.task().state === "completed") {
          const status = (await rpc("shipping.get", { id: props.task().id })) as {
            pullRequest?: { url?: unknown };
          } | null;
          const url = status?.pullRequest?.url;
          if (
            alive &&
            typeof url === "string" &&
            /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)
          ) {
            setPullRequest(url);
          }
        }
      } while (alive && readAgain && !props.workspace.readOnly);
    } catch {
      // Keep the last synced transcript when Cloud goes offline.
    } finally {
      reading = false;
    }
  }

  createEffect(
    on(
      () => [props.workspace.state.snapshot.seq, props.workspace.readOnly],
      () => void read(),
    ),
  );
  createEffect(
    on(
      () => props.task().revision,
      () => {
        setPatch("");
        setFingerprint("");
        setConfirming(false);
      },
    ),
  );

  async function run(work: () => Promise<void>, message: string) {
    if (busy() || props.workspace.readOnly) return;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      if (alive) setError(message);
    } finally {
      if (alive) setBusy(false);
    }
  }

  async function command(
    method: string,
    params: unknown,
    ready: (value: Record<string, unknown>) => boolean,
  ) {
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!alive || props.workspace.readOnly) throw new Error("cloud_offline");
      const result = await rpc(method, params, id);
      if (result && typeof result === "object" && ready(result as Record<string, unknown>))
        return result as Record<string, unknown>;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("cloud_request_pending");
  }

  const review = () =>
    run(async () => {
      const task = props.task();
      const diff = await command(
        "task.changes",
        { id: task.id },
        (value) => typeof value.patch === "string",
      );
      if (!alive || props.task().revision !== task.revision) return;
      setPatch(String(diff.patch));
      const preview = await command(
        "task.reviewCommitPreview",
        { id: task.id },
        (value) => typeof value.fingerprint === "string",
      );
      if (alive && props.task().revision === task.revision)
        setFingerprint(String(preview.fingerprint));
    }, "Couldn’t load the changes. Try again.");

  const accept = () =>
    run(async () => {
      const task = props.task();
      const commit = await command(
        "task.reviewCommit",
        { id: task.id, fingerprint: fingerprint(), confirmed: true },
        (value) => typeof value.head === "string",
      );
      if (!alive || props.task().revision !== task.revision) return;
      await rpc(
        "task.review",
        {
          id: task.id,
          revision: task.revision,
          decision: "accept",
          reviewedCommit: commit.head,
          confirmed: true,
        },
        crypto.randomUUID(),
      );
      if (alive) setConfirming(false);
      void read();
    }, "Couldn’t accept the changes. Reload the diff and try again.");

  const changes = () =>
    run(async () => {
      const task = props.task();
      if (!feedback().trim()) {
        setError("Enter the changes you want.");
        return;
      }
      await rpc(
        "task.review",
        {
          id: task.id,
          revision: task.revision,
          decision: "changes",
          feedback: feedback().trim(),
          confirmed: true,
        },
        crypto.randomUUID(),
      );
      if (alive) setFeedback("");
    }, "Couldn’t request changes. Try again.");

  return (
    <section class="models-section" aria-labelledby="cloud-task-name">
      <Stack gap={4}>
        <h2 class="models-heading" id="cloud-task-name">
          {props.task().title}
        </h2>
        <Show when={error()}>
          <p class="models-error" role="alert">
            {error()}
          </p>
        </Show>
        <Show when={props.interactions.length}>
          <h3 class="models-heading">Needs you</h3>
          <For each={props.interactions}>
            {(interaction) => (
              <CloudInteraction
                interaction={interaction}
                task={props.task()}
                workspace={props.workspace}
                api={props.api}
              />
            )}
          </For>
        </Show>
        <section aria-labelledby="cloud-task-transcript">
          <h3 id="cloud-task-transcript" class="models-heading">
            Transcript
          </h3>
          <ol class="models-list">
            <For each={items()}>
              {(item) => {
                const body = (item.body ?? {}) as { text?: unknown };
                return typeof body.text === "string" ? (
                  <li class="models-row">
                    <p>{body.text}</p>
                  </li>
                ) : undefined;
              }}
            </For>
          </ol>
        </section>
        <Show when={props.task().state === "review"}>
          <Cluster>
            <button
              type="button"
              class="models-button"
              disabled={busy() || props.workspace.readOnly}
              onClick={() => void review()}
            >
              View diff
            </button>
            <button
              type="button"
              class="models-button models-button-primary"
              disabled={busy() || props.workspace.readOnly || !fingerprint()}
              onClick={() => setConfirming(true)}
            >
              Accept changes
            </button>
          </Cluster>
          <Show when={patch()}>
            <pre class="models-command">{patch()}</pre>
          </Show>
          <Field
            label="Requested changes"
            input={(id) => (
              <textarea
                id={id}
                rows={3}
                class="models-limit-input"
                value={feedback()}
                onInput={(event) => setFeedback(event.currentTarget.value)}
              />
            )}
          />
          <Cluster>
            <button
              type="button"
              class="models-button"
              disabled={busy() || props.workspace.readOnly}
              onClick={() => void changes()}
            >
              Request changes
            </button>
          </Cluster>
        </Show>
        <Show when={pullRequest()}>
          {(url) => (
            <Cluster>
              <button type="button" class="models-button" onClick={() => props.onOpenLink(url())}>
                Open pull request
              </button>
            </Cluster>
          )}
        </Show>
      </Stack>
      <Show when={confirming()}>
        <ConfirmDialog
          title="Accept changes?"
          body="Zoltbot will create a review commit and open a pull request."
          confirmLabel="Accept changes"
          busy={busy()}
          error={error() || null}
          onConfirm={() => void accept()}
          onCancel={() => setConfirming(false)}
        />
      </Show>
    </section>
  );
}

function CloudInteraction(props: {
  interaction: Interaction;
  task: Task;
  workspace: CloudWorkspace;
  api: CloudDesktopApi;
}) {
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const draft = () => props.interaction.context?.macExec;
  const toolInput = () => props.interaction.context?.toolInput as { stdin?: unknown } | undefined;
  const isThisMac = () => {
    const target = draft()?.targetDeviceId;
    return target !== undefined && target === props.workspace.approvalDeviceId;
  };
  const mac = () => (isThisMac() ? "This Mac" : draft()?.targetDeviceId);
  const stdin = () => {
    const value = toolInput()?.stdin;
    return typeof value === "string" ? value : "";
  };
  const prefix = () =>
    props.interaction.items
      .flatMap((item) => item.choices ?? [])
      .find((choice) => choice.id === "allow_task_prefix");
  const answer = async (
    action: CloudAnswer["action"],
    choice?: CloudAnswer["choice"],
    values?: FormData,
  ) => {
    if (busy() || props.workspace.readOnly || (draft() && action === "accept" && !isThisMac()))
      return;
    setBusy(true);
    setError("");
    try {
      const answers = values
        ? Object.fromEntries(
            props.interaction.items.map((item) => {
              const options = values.getAll(item.id).map(String);
              const text = values.get(`other:${item.id}`);
              return [
                item.id,
                {
                  ...(options.length ? { options } : {}),
                  ...(text ? { other: String(text) } : {}),
                },
              ];
            }),
          )
        : undefined;
      await props.api.answer({
        owner: props.workspace.owner,
        id: props.interaction.id,
        version: props.interaction.version,
        action,
        ...(choice ? { choice } : {}),
        ...(answers ? { answers } : {}),
      });
    } catch {
      setError("Couldn’t send the answer. Check the request and try again.");
    } finally {
      setBusy(false);
    }
  };
  const disabled = () => busy() || props.workspace.readOnly;
  return (
    <Stack gap={3} class="models-section">
      <Show when={error()}>
        <p class="models-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show
        when={draft()}
        fallback={
          <Show when={props.interaction.type === "question" || props.interaction.type === "form"}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                event.currentTarget.reset();
                void answer("accept", undefined, values);
              }}
            >
              <Stack gap={3}>
                <For each={props.interaction.items}>
                  {(item) => (
                    <fieldset disabled={disabled()}>
                      <legend>{item.prompt}</legend>
                      <For each={item.options ?? []}>
                        {(option) => (
                          <label>
                            <input
                              type={item.multi ? "checkbox" : "radio"}
                              name={item.id}
                              value={option.id}
                            />{" "}
                            {option.label}
                          </label>
                        )}
                      </For>
                      <Show when={item.allowOther || !item.options?.length}>
                        <Field
                          label={item.options?.length ? "Other answer" : "Answer"}
                          input={(id) => (
                            <input
                              id={id}
                              type={item.secret ? "password" : "text"}
                              name={`other:${item.id}`}
                              class="models-limit-input"
                            />
                          )}
                        />
                      </Show>
                    </fieldset>
                  )}
                </For>
                <Cluster>
                  <button
                    type="submit"
                    class="models-button models-button-primary"
                    disabled={disabled()}
                  >
                    Send answer
                  </button>
                </Cluster>
              </Stack>
            </form>
          </Show>
        }
      >
        {(payload) => (
          <>
            <h4 class="models-heading">Run on my Mac</h4>
            <pre class="models-command">{payload().command}</pre>
            <dl>
              <dt>Folder</dt>
              <dd>{payload().cwd}</dd>
              <dt>Mac</dt>
              <dd>{mac()}</dd>
              <dt>Task</dt>
              <dd>{props.task.title}</dd>
              <dt>Agent</dt>
              <dd>{props.interaction.agentId}</dd>
            </dl>
            <Show when={stdin()}>
              {(input) => (
                <Stack gap={2}>
                  <h5 class="models-heading">Command input</h5>
                  <pre class="models-command">{input()}</pre>
                </Stack>
              )}
            </Show>
            <p>Command output goes to this Cloud task and the agent’s provider.</p>
            <Cluster>
              <button
                type="button"
                class="models-button models-button-primary"
                disabled={disabled() || !isThisMac()}
                onClick={() => void answer("accept", "allow_once")}
              >
                Run
              </button>
              <button
                type="button"
                class="models-button"
                disabled={disabled()}
                onClick={() => void answer("decline", "reject_once")}
              >
                Deny
              </button>
              <Show when={!stdin() && prefix()}>
                {(choice) => (
                  <button
                    type="button"
                    class="models-button"
                    disabled={disabled() || !isThisMac()}
                    onClick={() => void answer("accept", "allow_task_prefix")}
                  >
                    Allow {choice().id === "allow_task_prefix" ? choice().prefix : ""} for this task
                  </button>
                )}
              </Show>
            </Cluster>
          </>
        )}
      </Show>
    </Stack>
  );
}
