// M6: a skill an agent proposed, in the Memory page's Needs review. An update shows a line diff
// against the skill it changes; a new skill shows its whole text.
import { createMemo, For, Match, Show, Switch } from "solid-js";
import type { MemorySkillProposal } from "../../../shared/memory";
import { t } from "../i18n";
import { foldDiff, lineDiff } from "../skill-diff";
import { memoryMeta } from "./MemoryEntryRow";

const MARKS = { same: " ", added: "+", removed: "−" } as const;

export function SkillProposalCard(props: {
  proposal: MemorySkillProposal;
  busy: boolean;
  error: string | undefined;
  onDecide: (decision: "save" | "discard") => void;
}) {
  const id = () => props.proposal.id;
  const titleId = () => `skill-proposal-${id()}`;
  const diff = createMemo(() => {
    const base = props.proposal.base;
    return base === null ? null : foldDiff(lineDiff(base, props.proposal.body));
  });
  return (
    <li class="memory-row memory-proposal" data-proposal-id={id()}>
      <div class="memory-proposal-head">
        <span id={titleId()} class="memory-row-title">
          {t("memory.skill.title", { name: props.proposal.title })}
        </span>
      </div>
      <section
        class="skill-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll long skills here.
        tabIndex={0}
        aria-labelledby={titleId()}
      >
        <Show when={diff()} fallback={<pre class="skill-text">{props.proposal.body}</pre>}>
          {(lines) => (
            <ul class="skill-diff" aria-label={t("memory.skill.changes")}>
              <For each={lines()}>
                {(line) => (
                  <Switch>
                    <Match when={line.kind === "skip" && line}>
                      {(skip) => (
                        <li class="skill-diff-skip">
                          {t("memory.skill.unchanged", { count: skip().count })}
                        </li>
                      )}
                    </Match>
                    <Match when={line.kind !== "skip" && line}>
                      {(row) => (
                        <li class={`skill-diff-line skill-diff-${row().kind}`}>
                          <span class="skill-diff-mark" aria-hidden="true">
                            {MARKS[row().kind]}
                          </span>
                          <Show when={row().kind !== "same"}>
                            <span class="sr-only">
                              {t(
                                row().kind === "added"
                                  ? "memory.skill.added"
                                  : "memory.skill.removed",
                              )}
                            </span>
                          </Show>
                          <span class="skill-diff-text">{row().text}</span>
                        </li>
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </ul>
          )}
        </Show>
      </section>
      <div class="memory-proposal-foot">
        <span class="memory-row-meta">{memoryMeta(props.proposal, props.proposal.createdAt)}</span>
        <div class="memory-actions">
          <button
            type="button"
            class="zb-kit-button primary"
            disabled={props.busy}
            aria-describedby={titleId()}
            onClick={() => props.onDecide("save")}
          >
            {t("memory.skill.save")}
          </button>
          <button
            type="button"
            class="zb-kit-button"
            disabled={props.busy}
            aria-describedby={titleId()}
            onClick={() => props.onDecide("discard")}
          >
            {t("memory.review.discard")}
          </button>
        </div>
      </div>
      <Show when={props.error}>
        {(message) => (
          <p class="memory-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </li>
  );
}
