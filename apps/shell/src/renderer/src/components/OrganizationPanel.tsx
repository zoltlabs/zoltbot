import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { CompanyOverview, CompanyPerson, CompanyPlanSummary } from "../../../shared/ipc";
import type { BotProfile } from "../data";
import { AgentAvatar } from "./AgentAvatar";

interface OrganizationPanelProps {
  projectId: string;
  bots: BotProfile[];
  onOpenChat: (botId: string) => void;
  onOpenTasks?: (projectId: string) => void;
  onClose: () => void;
}

/**
 * A project's company beside its chat: who works where, plans waiting for the person's decision,
 * initiatives under way and the latest project brief. It re-reads whenever the daemon reports a
 * company change, so a plan an agent proposes shows up while the panel is open.
 */
export function OrganizationPanel(props: OrganizationPanelProps) {
  const [overview, setOverview] = createSignal<CompanyOverview | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal("");
  const [deciding, setDeciding] = createSignal<Record<string, true>>({});
  const [briefBusy, setBriefBusy] = createSignal(false);
  let generation = 0;

  async function load(projectId: string) {
    const current = ++generation;
    try {
      const next = await window.openbot.agent.readCompany(projectId);
      if (current === generation) {
        setOverview(next);
        setError(null);
      }
    } catch (cause) {
      if (current === generation) setError(message(cause, "Couldn't load the organization."));
    }
  }

  createEffect(
    on(
      () => props.projectId,
      (projectId) => {
        setOverview(null);
        setNotice("");
        setError(null);
        void load(projectId);
      },
    ),
  );

  const stop = window.openbot.agent.onEvent((event) => {
    if (event.type !== "company-changed") return;
    if (event.projectId === null || event.projectId === props.projectId) void load(props.projectId);
  });
  onCleanup(stop);

  async function decide(plan: CompanyPlanSummary, approve: boolean) {
    // The plan leaves the list at once and comes back only if the daemon refuses the decision.
    setDeciding((current) => ({ ...current, [plan.id]: true }));
    setError(null);
    setNotice("");
    try {
      const next = await window.openbot.agent.decidePlan({
        projectId: props.projectId,
        planId: plan.id,
        version: plan.version,
        approve,
      });
      ++generation;
      setOverview(next);
      setNotice(approve ? `Approved ${plan.title}.` : `Declined ${plan.title}.`);
    } catch (cause) {
      setError(message(cause, "Couldn't save your decision."));
    } finally {
      setDeciding(({ [plan.id]: _done, ...rest }) => rest);
    }
  }

  async function refreshBrief() {
    setBriefBusy(true);
    setError(null);
    setNotice("");
    try {
      const next = await window.openbot.agent.refreshBrief(props.projectId);
      ++generation;
      setOverview(next);
      setNotice("Brief updated.");
    } catch (cause) {
      setError(message(cause, "Couldn't update the brief."));
    } finally {
      setBriefBusy(false);
    }
  }

  const pendingPlans = () =>
    (overview()?.pendingPlans ?? []).filter((plan) => !deciding()[plan.id]);
  const botFor = (person: CompanyPerson) => props.bots.find((bot) => bot.id === person.botId);

  function PersonRow(rowProps: {
    person: CompanyPerson | null;
    label: string;
    fallbackName: string;
    employees: number;
  }) {
    const details = () => (
      <>
        <span class="organization-person-text">
          <strong>{rowProps.person?.name ?? rowProps.fallbackName}</strong>
          <span>{rowProps.label}</span>
        </span>
        <Show when={rowProps.employees > 0}>
          <span class="organization-count">{employeeCount(rowProps.employees)}</span>
        </Show>
      </>
    );
    return (
      <li>
        <Show
          when={rowProps.person}
          fallback={<div class="organization-person organization-person-vacant">{details()}</div>}
        >
          {(person) => (
            <button
              type="button"
              class="organization-person"
              onClick={() => props.onOpenChat(person().botId)}
            >
              <AgentAvatar bot={botFor(person())} class="organization-avatar" />
              {details()}
            </button>
          )}
        </Show>
      </li>
    );
  }

  return (
    <>
      <header class="agent-settings-header">
        <span aria-hidden="true" />
        <h2>Organization</h2>
        <button
          type="button"
          class="agent-settings-nav-button"
          aria-label="Close organization"
          onClick={props.onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div class="agent-settings-content organization-content">
        <Show when={error()}>
          {(text) => (
            <p class="agent-settings-save-error organization-error" role="alert">
              {text()}
            </p>
          )}
        </Show>
        <output class="organization-notice">{notice()}</output>
        <Show
          when={overview()}
          fallback={
            <Show when={!error()}>
              <p class="organization-empty">Loading…</p>
            </Show>
          }
        >
          {(company) => (
            <>
              <section class="agent-settings-model" aria-labelledby="organization-people-heading">
                <div class="agent-settings-section-heading organization-people-heading">
                  <strong id="organization-people-heading">{company().projectName}</strong>
                  <Show when={props.onOpenTasks}>
                    {(open) => (
                      <button
                        type="button"
                        class="organization-link"
                        aria-keyshortcuts="Meta+T"
                        onClick={() => open()(props.projectId)}
                      >
                        Tasks
                      </button>
                    )}
                  </Show>
                </div>
                <ul class="organization-list">
                  <PersonRow
                    person={company().ceo}
                    label="CEO"
                    fallbackName="No CEO"
                    employees={company().ceoEmployees}
                  />
                  <For each={company().teams}>
                    {(team) => (
                      <PersonRow
                        person={team.manager}
                        label={team.manager ? `${team.name} manager` : `${team.name}, no manager`}
                        fallbackName={team.name}
                        employees={team.employees}
                      />
                    )}
                  </For>
                </ul>
              </section>

              <Show when={pendingPlans().length > 0}>
                <section class="organization-section" aria-labelledby="organization-plans-heading">
                  <h3 id="organization-plans-heading">Plans to review</h3>
                  <For each={pendingPlans()}>
                    {(plan) => (
                      <article class="organization-plan" aria-label={plan.title}>
                        <h4>{plan.title}</h4>
                        <Show when={plan.explanation && plan.explanation !== plan.title}>
                          <p class="organization-muted">{plan.explanation}</p>
                        </Show>
                        <ol class="organization-changes">
                          <For each={plan.changes}>
                            {(change) => (
                              <li>
                                <span>{change.summary}</span>
                                <Show when={change.why}>
                                  <span class="organization-muted">{change.why}</span>
                                </Show>
                              </li>
                            )}
                          </For>
                        </ol>
                        <div class="organization-actions">
                          <button
                            type="button"
                            class="organization-button"
                            aria-label={`Decline ${plan.title}`}
                            onClick={() => void decide(plan, false)}
                          >
                            Decline
                          </button>
                          <button
                            type="button"
                            class="organization-button organization-button-primary"
                            aria-label={`Approve ${plan.title}`}
                            onClick={() => void decide(plan, true)}
                          >
                            Approve
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </section>
              </Show>

              <Show when={company().initiatives.length > 0}>
                <section
                  class="organization-section"
                  aria-labelledby="organization-initiatives-heading"
                >
                  <h3 id="organization-initiatives-heading">Initiatives</h3>
                  <ul class="organization-initiatives">
                    <For each={company().initiatives}>
                      {(initiative) => (
                        <li>
                          <strong>{initiative.title}</strong>
                          <span class="organization-muted">
                            {initiativeStatus(initiative.state, initiative.priority)}
                            <Show when={initiative.total > 0}>
                              {` · ${initiative.finished} of ${initiative.total} done`}
                            </Show>
                          </span>
                          <Show when={initiative.owner}>
                            {(owner) => (
                              <button
                                type="button"
                                class="organization-link"
                                onClick={() => props.onOpenChat(owner().botId)}
                              >
                                {owner().name}
                              </button>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              </Show>

              <section class="organization-section" aria-labelledby="organization-brief-heading">
                <div class="organization-section-heading">
                  <h3 id="organization-brief-heading">Project brief</h3>
                  <button
                    type="button"
                    class="agent-settings-nav-button"
                    aria-label="Refresh brief"
                    disabled={briefBusy()}
                    onClick={() => void refreshBrief()}
                  >
                    <RefreshIcon />
                  </button>
                </div>
                <Show
                  when={company().brief}
                  fallback={<p class="organization-muted">No brief yet.</p>}
                >
                  {(brief) => (
                    <>
                      <p class="organization-brief">{brief().summary}</p>
                      <p class="organization-muted">
                        <time dateTime={brief().createdAt}>{briefDate(brief().createdAt)}</time>
                      </p>
                    </>
                  )}
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>
    </>
  );
}

function employeeCount(count: number): string {
  return count === 1 ? "1 employee" : `${count} employees`;
}

function initiativeStatus(state: string, priority: string): string {
  const label =
    state === "review" ? "In review" : `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
  return priority && priority !== "normal" ? `${label} · ${priority} priority` : label;
}

function briefDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path d="m5 5 10 10M15 5 5 15" stroke-width="1.4" stroke-linecap="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <path
        d="M15.5 9.5a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3h-3"
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** The header button that opens this panel. */
export function OrganizationIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" class="size-[14px] fill-none stroke-current">
      <rect x="7.5" y="2.5" width="5" height="4" rx="1" stroke-width="1.3" />
      <rect x="2.5" y="13.5" width="5" height="4" rx="1" stroke-width="1.3" />
      <rect x="12.5" y="13.5" width="5" height="4" rx="1" stroke-width="1.3" />
      <path d="M10 6.5v3.5M5 13.5V10h10v3.5" stroke-width="1.3" stroke-linejoin="round" />
    </svg>
  );
}
