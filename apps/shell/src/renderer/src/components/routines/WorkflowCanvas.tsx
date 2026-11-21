// R7: one workflow as a graph. Steps are buttons, so Tab walks them in graph order and arrow
// keys follow the edges; the side panel shows the chosen step and answers approval waits.
import { createMemo, createSignal, For, Show } from "solid-js";
import type {
  WorkflowItem,
  WorkflowRunItem,
  WorkflowStepState,
} from "../../../../shared/workflows";
import { t } from "../../i18n";
import {
  kindText,
  reasonText,
  runLabel,
  stepDetail,
  stepStateText,
  triggerText,
} from "./workflow-format";
import { edgePath, layoutWorkflow, neighbour, STEP_HEIGHT, STEP_WIDTH } from "./workflow-layout";

const PANEL_ID = "workflow-step-panel";
/** A step's state, and for a condition that ran, which branch it took. */
function stepText(state: WorkflowStepState | undefined, branch: string | undefined) {
  if (!state) return t("workflows.step.noRun");
  const text = stepStateText(state);
  if (branch !== "true" && branch !== "false") return text;
  return t("workflows.step.took", {
    state: text,
    port: t(branch === "true" ? "workflows.port.yes" : "workflows.port.no"),
  });
}
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function WorkflowCanvas(props: {
  item: WorkflowItem;
  timezone: string;
  busy: boolean;
  onDecide(run: WorkflowRunItem, stepId: string, decision: "continue" | "stop"): Promise<void>;
}) {
  const layout = createMemo(() => layoutWorkflow(props.item.steps, props.item.edges));
  const [runId, setRunId] = createSignal<string>();
  const [selected, setSelected] = createSignal<string>();
  const buttons = new Map<string, HTMLButtonElement>();
  const run = () =>
    props.item.runs.find((entry) => entry.id === runId()) ?? props.item.runs[0] ?? undefined;
  const stateOf = (id: string) => run()?.steps.find((step) => step.id === id);
  const names = createMemo(() => new Map(props.item.steps.map((step) => [step.id, step.name])));
  // Until someone picks a step, show the one waiting for them.
  const shown = () => selected() ?? run()?.steps.find((step) => step.state === "needs_you")?.id;
  const chosen = () => props.item.steps.find((step) => step.id === shown());
  const total = () => props.item.steps.length;

  let heading: HTMLHeadingElement | undefined;
  // The decision buttons go away once answered, so focus returns to the step's own button.
  async function decide(current: WorkflowRunItem, stepId: string, decision: "continue" | "stop") {
    if (props.busy) return;
    setSelected(stepId);
    await props.onDecide(current, stepId, decision);
    (buttons.get(stepId) ?? heading)?.focus();
  }

  function move(id: string, event: KeyboardEvent) {
    if (!ARROWS.has(event.key)) return;
    const next = neighbour(
      layout().placed,
      props.item.edges,
      id,
      event.key as "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
    );
    if (!next) return;
    event.preventDefault();
    buttons.get(next)?.focus();
  }

  return (
    <div class="workflow-detail">
      <div class="workflow-runbar">
        <Show
          when={props.item.runs.length}
          fallback={<p class="routines-note">{t("workflows.run.none")}</p>}
        >
          <label class="workflow-run-pick">
            <span>{t("workflows.run.label")}</span>
            <select
              value={run()?.id ?? ""}
              onChange={(event) => setRunId(event.currentTarget.value)}
            >
              <For each={props.item.runs}>
                {(entry) => <option value={entry.id}>{runLabel(entry, props.timezone)}</option>}
              </For>
            </select>
          </label>
          <Show when={reasonText(run()?.reason)}>
            {(reason) => <span class="routines-meta">{reason()}</span>}
          </Show>
        </Show>
      </div>
      <div class="workflow-body">
        <section
          class="workflow-canvas"
          aria-label={t("workflows.canvas", { name: props.item.name })}
        >
          <div
            class="workflow-plane"
            style={{ width: `${layout().width}px`, height: `${layout().height}px` }}
          >
            <svg
              class="workflow-edges"
              width={layout().width}
              height={layout().height}
              aria-hidden="true"
            >
              <For each={props.item.edges}>
                {(edge) => {
                  const from = () => layout().placed.find((entry) => entry.step.id === edge.from);
                  const to = () => layout().placed.find((entry) => entry.step.id === edge.to);
                  const path = () => {
                    const start = from();
                    const end = to();
                    return start && end ? edgePath(start, end) : "";
                  };
                  return (
                    <Show when={path()}>
                      <path
                        d={path()}
                        classList={{
                          "workflow-edge": true,
                          "workflow-edge-taken":
                            !!edge.port && stateOf(edge.from)?.branch === edge.port,
                          "workflow-edge-untaken":
                            !!edge.port &&
                            !!stateOf(edge.from)?.branch &&
                            stateOf(edge.from)?.branch !== edge.port,
                        }}
                      />
                      <Show when={edge.port}>
                        <text
                          classList={{
                            "workflow-port": true,
                            "workflow-port-taken": stateOf(edge.from)?.branch === edge.port,
                          }}
                          x={(from()?.x ?? 0) + STEP_WIDTH + 8}
                          y={(from()?.y ?? 0) + STEP_HEIGHT / 2 + (edge.port === "true" ? -6 : 14)}
                        >
                          {edge.port === "true" ? t("workflows.port.yes") : t("workflows.port.no")}
                        </text>
                      </Show>
                    </Show>
                  );
                }}
              </For>
            </svg>
            <ol class="workflow-steps">
              <For each={layout().placed}>
                {(entry, index) => {
                  const state = () => stateOf(entry.step.id)?.state;
                  const text = () => stepText(state(), stateOf(entry.step.id)?.branch);
                  return (
                    <li style={{ left: `${entry.x}px`, top: `${entry.y}px` }}>
                      <button
                        type="button"
                        ref={(element) => buttons.set(entry.step.id, element)}
                        class="workflow-step"
                        classList={{
                          [`workflow-step-${state() ?? "idle"}`]: true,
                          "workflow-step-chosen": shown() === entry.step.id,
                        }}
                        aria-current={shown() === entry.step.id ? "true" : undefined}
                        aria-controls={PANEL_ID}
                        title={entry.step.name}
                        aria-label={t("workflows.step.label", {
                          number: index() + 1,
                          total: total(),
                          kind: kindText(entry.step),
                          name: entry.step.name,
                          state: text(),
                        })}
                        onClick={() => setSelected(entry.step.id)}
                        onKeyDown={(event) => move(entry.step.id, event)}
                      >
                        <span class="workflow-step-kind">{kindText(entry.step)}</span>
                        <span class="workflow-step-name">{entry.step.name}</span>
                        <Show when={state()}>
                          <span class="workflow-step-state">{text()}</span>
                        </Show>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ol>
          </div>
        </section>
        <Show
          when={chosen()}
          fallback={
            <p id={PANEL_ID} class="workflow-panel routines-note">
              {t("workflows.panel.pick")}
            </p>
          }
        >
          {(step) => {
            const state = () => stateOf(step().id)?.state;
            const approval = () =>
              !!step().wait && "approval" in (step().wait ?? {}) && state() === "needs_you";
            return (
              <section
                id={PANEL_ID}
                class="workflow-panel"
                classList={{ "workflow-panel-asks": approval() }}
                aria-label={t("workflows.panel.label", { name: step().name })}
              >
                <h3 tabindex="-1" ref={heading}>
                  {step().name}
                </h3>
                <dl>
                  <Show when={step().kind === "trigger"}>
                    <dt>{t("workflows.panel.when")}</dt>
                    <dd>{triggerText(props.item)}</dd>
                  </Show>
                  <Show when={step().agent}>
                    <dt>{t("workflows.panel.agent")}</dt>
                    <dd>{step().agent}</dd>
                  </Show>
                  <Show when={stepDetail(step(), names())}>
                    {(detail) => (
                      <>
                        <dt>{t("workflows.panel.does")}</dt>
                        <dd>{detail()}</dd>
                      </>
                    )}
                  </Show>
                </dl>
                <Show when={step().brief}>
                  {(brief) => <p class="workflow-brief">{brief()}</p>}
                </Show>
                <Show when={approval() && run()}>
                  {(current) => (
                    <div class="workflow-decide">
                      <p class="workflow-ask">{t("workflows.decide.question")}</p>
                      <button
                        type="button"
                        class="zb-kit-button primary"
                        aria-disabled={props.busy}
                        onClick={() => decide(current(), step().id, "continue")}
                      >
                        {t("workflows.decide.continue")}
                      </button>
                      <button
                        type="button"
                        class="zb-kit-button"
                        aria-disabled={props.busy}
                        onClick={() => decide(current(), step().id, "stop")}
                      >
                        {t("workflows.decide.stop")}
                      </button>
                    </div>
                  )}
                </Show>
              </section>
            );
          }}
        </Show>
      </div>
    </div>
  );
}
