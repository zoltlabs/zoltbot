// R7: the side panel's form for editing a step or adding one after it. Saving publishes a new
// version of the workflow; the daemon checks the whole graph before it accepts it.
import { createSignal, onMount, Show } from "solid-js";
import type {
  WorkflowAgent,
  WorkflowEdge,
  WorkflowEdit,
  WorkflowStep,
  WorkflowStepFields,
} from "../../../../shared/workflows";
import { t } from "../../i18n";
import { Field, Select } from "../../kit";

type AddKind = "agent" | "wait" | "condition";
type TestKind = "contains" | "equals" | "outcome";
type WaitMode = "approval" | "minutes";
type Port = "true" | "false";

interface Draft {
  kind: AddKind | WorkflowStep["kind"];
  port: Port;
  name: string;
  agentId: string;
  brief: string;
  waitMode: WaitMode;
  minutes: string;
  from: string;
  test: TestKind;
  value: string;
}

/** Steps before `id` (and `id` itself when asked) whose output a condition can test. */
function producers(steps: WorkflowStep[], edges: WorkflowEdge[], id: string, self: boolean) {
  const seen = new Set<string>(self ? [id] : []);
  const queue = [id];
  while (queue.length) {
    const at = queue.shift() as string;
    for (const edge of edges)
      if (edge.to === at && !seen.has(edge.from)) {
        seen.add(edge.from);
        queue.push(edge.from);
      }
  }
  return steps.filter(
    (step) => seen.has(step.id) && (step.kind === "agent" || step.kind === "media"),
  );
}

function draftOf(
  mode: "edit" | "add",
  step: WorkflowStep,
  sources: WorkflowStep[],
  agents: WorkflowAgent[],
): Draft {
  const editing = mode === "edit";
  const wait = editing ? step.wait : undefined;
  const nearest = sources.at(-1)?.id ?? "";
  return {
    kind: editing ? step.kind : "agent",
    port: "true",
    name: editing ? step.name : "",
    agentId: (editing && step.agentId) || agents[0]?.id || "",
    brief: (editing && step.brief) || "",
    waitMode: wait && "minutes" in wait ? "minutes" : "approval",
    minutes: wait && "minutes" in wait ? String(wait.minutes) : "60",
    from:
      (editing && step.test?.from) ||
      (step.kind === "agent" || step.kind === "media" ? step.id : nearest),
    test: (editing && step.test?.kind) || "contains",
    value: (editing && step.test?.value) || "",
  };
}

function fieldsOf(draft: Draft): WorkflowStepFields {
  const name = draft.name.trim();
  if (draft.kind === "agent" || draft.kind === "media")
    return { name, agentId: draft.agentId, brief: draft.brief };
  if (draft.kind === "wait")
    return {
      name,
      wait: draft.waitMode === "approval" ? { approval: true } : { minutes: Number(draft.minutes) },
    };
  if (draft.kind === "condition")
    return { name, test: { from: draft.from, kind: draft.test, value: draft.value } };
  return { name };
}

export function WorkflowStepForm(props: {
  mode: "edit" | "add";
  step: WorkflowStep;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  agents: WorkflowAgent[];
  busy: boolean;
  /** Resolves to an error to show, or nothing once saved. */
  onSave(edit: WorkflowEdit): Promise<string | undefined>;
  onCancel(): void;
}) {
  // Conditions test a step before them: before a new step's place, or before the edited condition.
  const sources = () => producers(props.steps, props.edges, props.step.id, props.mode === "add");
  const [draft, setDraft] = createSignal(draftOf(props.mode, props.step, sources(), props.agents));
  const [error, setError] = createSignal<string>();
  const patch = (next: Partial<Draft>) => setDraft({ ...draft(), ...next });
  const nameError = () => (error() === t("workflows.form.nameRequired") ? error() : undefined);
  let form: HTMLFormElement | undefined;
  let nameInput: HTMLInputElement | undefined;
  const FIELDS = "button, input, textarea";
  onMount(() => (form?.querySelector(FIELDS) as HTMLElement | null)?.focus());

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (props.busy) return;
    if (!draft().name.trim()) {
      setError(t("workflows.form.nameRequired"));
      // The field carries the error, so moving focus there reads it out.
      return nameInput?.focus();
    }
    if (draft().kind === "condition" && !draft().value.trim())
      return setError(t("workflows.form.valueRequired"));
    const fields = fieldsOf(draft());
    const edit: WorkflowEdit =
      props.mode === "edit"
        ? { op: "update", stepId: props.step.id, fields }
        : {
            op: "add",
            after: props.step.id,
            kind: draft().kind as AddKind,
            fields,
            ...(props.step.kind === "condition" ? { port: draft().port } : {}),
          };
    setError(await props.onSave(edit));
  }

  const kind = () => draft().kind;
  return (
    <form
      ref={form}
      class="workflow-form"
      aria-label={t(
        props.mode === "edit" ? "workflows.form.editLabel" : "workflows.form.addLabel",
        {
          name: props.step.name,
        },
      )}
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => event.key === "Escape" && props.onCancel()}
    >
      <Show when={props.mode === "add"}>
        <Select<AddKind>
          label={t("workflows.form.kind")}
          value={draft().kind as AddKind}
          onChange={(next) => patch({ kind: next })}
          options={[
            { value: "agent", label: t("workflows.kind.agent") },
            { value: "wait", label: t("workflows.kind.wait") },
            { value: "condition", label: t("workflows.kind.condition") },
          ]}
        />
        <Show when={props.step.kind === "condition"}>
          <Select<Port>
            label={t("workflows.form.branch")}
            value={draft().port}
            onChange={(port) => patch({ port })}
            options={[
              { value: "true", label: t("workflows.port.yes") },
              { value: "false", label: t("workflows.port.no") },
            ]}
          />
        </Show>
      </Show>
      <Field
        label={t("workflows.form.name")}
        error={nameError()}
        input={(id, describedBy) => (
          <input
            id={id}
            ref={nameInput}
            aria-invalid={!!nameError() || undefined}
            aria-describedby={describedBy}
            class="zb-kit-input"
            maxLength={120}
            value={draft().name}
            onInput={(event) => patch({ name: event.currentTarget.value })}
          />
        )}
      />
      <Show when={kind() === "agent" || kind() === "media"}>
        <Show
          when={props.agents.length}
          fallback={<p class="routines-note">{t("workflows.form.noAgents")}</p>}
        >
          <Select<string>
            label={t("workflows.panel.agent")}
            value={draft().agentId}
            onChange={(agentId) => patch({ agentId })}
            options={props.agents.map((agent) => ({ value: agent.id, label: agent.name }))}
          />
        </Show>
        <Field
          label={t("workflows.form.brief")}
          input={(id) => (
            <textarea
              id={id}
              class="zb-kit-input workflow-form-brief"
              rows={5}
              maxLength={4000}
              value={draft().brief}
              onInput={(event) => patch({ brief: event.currentTarget.value })}
            />
          )}
        />
      </Show>
      <Show when={kind() === "wait"}>
        <Select<WaitMode>
          label={t("workflows.form.wait")}
          value={draft().waitMode}
          onChange={(waitMode) => patch({ waitMode })}
          options={[
            { value: "approval", label: t("workflows.form.waitApproval") },
            { value: "minutes", label: t("workflows.form.waitMinutes") },
          ]}
        />
        <Show when={draft().waitMode === "minutes"}>
          <Field
            label={t("workflows.form.minutes")}
            input={(id) => (
              <input
                id={id}
                class="zb-kit-input"
                type="number"
                min={1}
                max={43200}
                value={draft().minutes}
                onInput={(event) => patch({ minutes: event.currentTarget.value })}
              />
            )}
          />
        </Show>
      </Show>
      <Show when={kind() === "condition"}>
        <Show when={!sources().length}>
          <p class="routines-note">{t("workflows.form.noSources")}</p>
        </Show>
        <Select<string>
          label={t("workflows.form.checks")}
          value={draft().from}
          onChange={(from) => patch({ from })}
          options={sources().map((step) => ({ value: step.id, label: step.name }))}
        />
        <Select<TestKind>
          label={t("workflows.form.test")}
          value={draft().test}
          onChange={(test) => patch({ test })}
          options={[
            { value: "contains", label: t("workflows.form.contains") },
            { value: "equals", label: t("workflows.form.equals") },
            { value: "outcome", label: t("workflows.form.outcome") },
          ]}
        />
        <Field
          label={t("workflows.form.value")}
          input={(id) => (
            <input
              id={id}
              class="zb-kit-input"
              maxLength={200}
              value={draft().value}
              onInput={(event) => patch({ value: event.currentTarget.value })}
            />
          )}
        />
      </Show>
      <Show when={error() && !nameError()}>
        {(message) => (
          <p class="zb-kit-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="workflow-decide">
        <button type="submit" class="zb-kit-button primary" aria-disabled={props.busy}>
          {t("workflows.form.save")}
        </button>
        <button type="button" class="zb-kit-button" onClick={() => props.onCancel()}>
          {t("routines.cancel")}
        </button>
      </div>
    </form>
  );
}
