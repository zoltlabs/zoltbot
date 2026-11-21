// R7: the Workflows view on the Routines page. A list of workflows; opening one shows its canvas
// with Run now, Pause and the newest runs.
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type {
  WorkflowAgent,
  WorkflowEdit,
  WorkflowItem,
  WorkflowRunItem,
} from "../../../../shared/workflows";
import { t } from "../../i18n";
import { errorText } from "./routine-format";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { workflowMeta, workflowStatus } from "./workflow-format";
import "./workflows.css";

/** What the status line reads out once an action finishes. */
type Status = Promise<string>;
const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function WorkflowsView(props: { onStatus(message: string): void }) {
  const [items, setItems] = createStore<WorkflowItem[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [agents, setAgents] = createSignal<WorkflowAgent[]>([]);
  let back: HTMLButtonElement | undefined;
  const rows = new Map<string, HTMLButtonElement>();

  async function load() {
    try {
      setItems(reconcile(await window.openbot.workflows.list(), { key: "id" }));
      setError(null);
    } catch (problem) {
      setError(errorText(problem) || t("routines.failed"));
    } finally {
      setLoaded(true);
    }
  }
  onMount(() => {
    void load();
    window.openbot.workflows
      .agents()
      .then(setAgents)
      .catch(() => undefined);
    const timer = setInterval(() => void load(), 10_000);
    onCleanup(() => clearInterval(timer));
  });

  async function act(work: () => Status) {
    if (busy()) return;
    setBusy(true);
    setError(null);
    props.onStatus("");
    try {
      const message = await work();
      await load();
      props.onStatus(message);
    } catch (problem) {
      setError(errorText(problem) || t("routines.failed"));
    } finally {
      setBusy(false);
    }
  }
  /** Publishes one change; the form shows any error itself. */
  async function edit(item: WorkflowItem, change: WorkflowEdit) {
    if (busy()) return {};
    setBusy(true);
    setError(null);
    props.onStatus("");
    try {
      const outcome = await window.openbot.workflows.edit({
        id: item.id,
        version: item.version,
        edit: change,
      });
      await load();
      props.onStatus(t("workflows.form.saved", { name: item.name }));
      return outcome;
    } catch (problem) {
      // A newer version may have landed; the next try starts from it.
      await load();
      return { error: errorText(problem) || t("routines.failed") };
    } finally {
      setBusy(false);
    }
  }
  const current = () => items.find((item) => item.id === open());
  function show(id: string | undefined) {
    const leaving = open();
    setOpen(id);
    // Focus follows the change: into the workflow, or back to its row.
    queueMicrotask(() => (id ? back?.focus() : leaving && rows.get(leaving)?.focus()));
  }

  return (
    <div class="workflows-view">
      <Show when={error()}>
        {(message) => (
          <p class="tasks-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={loaded()}>
        <Show
          when={current()}
          fallback={
            <Show when={items.length} fallback={<p class="tasks-empty">{t("workflows.empty")}</p>}>
              <ul class="routines-list">
                <For each={items}>
                  {(item) => (
                    <li class="routines-item" classList={{ "routines-item-paused": item.paused }}>
                      <button
                        type="button"
                        class="routines-item-main workflow-open"
                        ref={(element) => rows.set(item.id, element)}
                        onClick={() => show(item.id)}
                      >
                        <span class="routines-item-text">
                          <span class="routines-name">{item.name}</span>
                          <span class="routines-meta">{workflowMeta(item)}</span>
                        </span>
                        <span class="routines-status">{workflowStatus(item)}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          }
        >
          {(item) => (
            <section class="workflow-open-view" aria-labelledby="workflow-title">
              <div class="workflow-head">
                <button
                  type="button"
                  class="zb-kit-button"
                  ref={back}
                  onClick={() => show(undefined)}
                >
                  {t("workflows.back")}
                </button>
                <h2 id="workflow-title" class="workflow-title">
                  {item().name}
                </h2>
                <span class="routines-status">{workflowStatus(item())}</span>
                <div class="workflow-actions">
                  <Show when={!item().paused}>
                    <button
                      type="button"
                      class="zb-kit-button primary"
                      aria-disabled={busy()}
                      onClick={() =>
                        !busy() &&
                        void act(async () => {
                          await window.openbot.workflows.run(item().id);
                          return t("workflows.started", { name: item().name });
                        })
                      }
                    >
                      {t("routines.action.runNow")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    class="zb-kit-button"
                    aria-disabled={busy()}
                    onClick={() =>
                      void act(async () => {
                        const paused = !item().paused;
                        await window.openbot.workflows.setPaused({ id: item().id, paused });
                        return t(paused ? "routines.pausedStatus" : "routines.resumedStatus", {
                          name: item().name,
                        });
                      })
                    }
                  >
                    {t(item().paused ? "routines.action.resume" : "routines.action.pause")}
                  </button>
                </div>
              </div>
              <WorkflowCanvas
                item={item()}
                agents={agents()}
                onEdit={(change) => edit(item(), change)}
                timezone={timezone()}
                busy={busy()}
                onDecide={(run: WorkflowRunItem, stepId, decision) =>
                  act(async () => {
                    await window.openbot.workflows.decide({ runId: run.id, stepId, decision });
                    return t(
                      decision === "continue"
                        ? "workflows.decided.continue"
                        : "workflows.decided.stop",
                      { name: item().name },
                    );
                  })
                }
              />
            </section>
          )}
        </Show>
      </Show>
    </div>
  );
}
