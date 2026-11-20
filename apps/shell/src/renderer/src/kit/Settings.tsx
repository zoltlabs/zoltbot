import { createUniqueId, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

export interface SettingsRowProps {
  label: string;
  /** The control. Pass `id` to it so the row's label names it, and `describedBy` to aria-describedby. */
  control: (id: string, describedBy: string | undefined) => JSX.Element;
  /** A unit shown after the control, such as "minutes". */
  unit?: string;
  error?: string | null;
  /**
   * Only for destructive or cost-bearing choices: what happens if the person
   * picks it, for example "Uses about $2 a day". Never a description of the
   * setting. There is deliberately no description or hint prop.
   */
  consequence?: string;
}

export function SettingsRow(props: SettingsRowProps) {
  const id = createUniqueId();
  const noteId = createUniqueId();
  return (
    <div class="zb-kit-settings-row" classList={{ invalid: !!props.error }}>
      <div class="zb-kit-settings-main">
        <label class="zb-kit-settings-label" for={id}>
          {props.label}
        </label>
        <div class="zb-kit-settings-control">
          {props.control(id, props.error || props.consequence ? noteId : undefined)}
          <Show when={props.unit}>
            <span class="zb-kit-unit">{props.unit}</span>
          </Show>
        </div>
      </div>
      <Show when={props.error ?? props.consequence}>
        <p id={noteId} class={props.error ? "zb-kit-error" : "zb-kit-consequence"}>
          {props.error ?? props.consequence}
        </p>
      </Show>
    </div>
  );
}

export interface FieldProps {
  label: string;
  /** The input. Pass `id` to it and `describedBy` to aria-describedby. A placeholder is an example value, never an instruction. */
  input: (id: string, describedBy: string | undefined) => JSX.Element;
  unit?: string;
  error?: string | null;
}

export function Field(props: FieldProps) {
  const id = createUniqueId();
  const errorId = createUniqueId();
  return (
    <div class="zb-kit-field" classList={{ invalid: !!props.error }}>
      <label class="zb-kit-field-label" for={id}>
        {props.label}
      </label>
      <div class="zb-kit-field-input">
        {props.input(id, props.error ? errorId : undefined)}
        <Show when={props.unit}>
          <span class="zb-kit-unit">{props.unit}</span>
        </Show>
      </div>
      <Show when={props.error}>
        <p id={errorId} class="zb-kit-error">
          {props.error}
        </p>
      </Show>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  /** The way to fill this place, such as an "Add an agent" button. */
  action?: JSX.Element;
  /** One sentence, only when the title alone doesn't say how this place fills up. */
  body?: string;
  /** Heading level that fits the page's outline. */
  level?: 2 | 3 | 4;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class="zb-kit-empty">
      <Dynamic component={`h${props.level ?? 3}`} class="zb-kit-empty-title">
        {props.title}
      </Dynamic>
      <Show when={props.body}>
        <p class="zb-kit-empty-body">{props.body}</p>
      </Show>
      <Show when={props.action}>
        <div class="zb-kit-empty-action">{props.action}</div>
      </Show>
    </div>
  );
}

type Gap = 1 | 2 | 3 | 4 | 6 | 8;

/** Children in a column with a token gap (1 = 4px). */
export function Stack(props: { gap?: Gap; children: JSX.Element; class?: string }) {
  return (
    <div
      class={`zb-kit-stack ${props.class ?? ""}`}
      style={{ "--zb-kit-gap": `${(props.gap ?? 2) * 4}px` }}
    >
      {props.children}
    </div>
  );
}

/** Children in a wrapping row with a token gap (1 = 4px). */
export function Cluster(props: {
  gap?: Gap;
  align?: "start" | "center" | "end" | "baseline";
  justify?: "start" | "end" | "between";
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div
      class={`zb-kit-cluster ${props.class ?? ""}`}
      style={{
        "--zb-kit-gap": `${(props.gap ?? 2) * 4}px`,
        "align-items": props.align ?? "center",
        "justify-content":
          props.justify === "between"
            ? "space-between"
            : props.justify === "end"
              ? "flex-end"
              : "flex-start",
      }}
    >
      {props.children}
    </div>
  );
}
