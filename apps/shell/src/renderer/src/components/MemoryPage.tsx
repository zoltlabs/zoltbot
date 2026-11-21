// S5: the Memory page. Lists what agents remember, with filters, and what they proposed to
// remember for the owner to keep or discard.
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import type { MemoryProposal } from "../../../shared/memory";
import { t } from "../i18n";
import { Select } from "../kit";
import { agentOptions, filterMemory, type MemoryFilter, projectOptions } from "../memory";
import type { MemoryStore } from "../memory-store";
import { MemoryEntryRow, memoryMeta } from "./MemoryEntryRow";
import { SidebarToggleIcon } from "./SidebarIcons";
import "../memory.css";

const OP_KEYS = {
  create: "memory.review.op.create",
  revise: "memory.review.op.revise",
  confirm: "memory.review.op.confirm",
  forget: "memory.review.op.forget",
  merge: "memory.review.op.merge",
} as const;

export function MemoryPage(props: {
  store: MemoryStore;
  /** Shows only what this agent wrote, as from the agent's settings. */
  agentId?: string | null;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
}) {
  const [reviewing, setReviewing] = createSignal(false);
  const [filter, setFilter] = createSignal<MemoryFilter>({
    agentId: props.agentId ?? "",
    projectId: "",
    query: "",
  });
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [announcement, setAnnouncement] = createSignal("");
  let heading: HTMLHeadingElement | undefined;
  onMount(() => heading?.focus());
  createEffect(
    on(
      () => props.agentId,
      (agentId) => setFilter((current) => ({ ...current, agentId: agentId ?? "" })),
      { defer: true },
    ),
  );

  const view = () => props.store.view();
  const entries = createMemo(() => filterMemory(view().entries, filter()));
  const proposals = createMemo(() => filterMemory(view().proposals, filter()));
  // Rows are keyed by id, so a new revision updates a row in place: an open edit, its error and
  // focus stay put.
  const sameIds = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, index) => id === b[index]);
  const entryIds = createMemo(() => entries().map((entry) => entry.id), [], { equals: sameIds });
  const proposalIds = createMemo(() => proposals().map((item) => item.id), [], {
    equals: sameIds,
  });
  const entryById = createMemo(() => new Map(view().entries.map((entry) => [entry.id, entry])));
  const proposalById = createMemo(
    () => new Map(view().proposals.map((proposal) => [proposal.id, proposal])),
  );
  const [deciding, setDeciding] = createSignal<ReadonlySet<string>>(new Set());
  const [decideErrors, setDecideErrors] = createSignal<Record<string, string>>({});

  // When a row is about to go away, remember its neighbor, and move focus there once it's gone.
  let pendingFocus: { gone: string; next: string | null; kind: "entry" | "proposal" } | null = null;
  function rememberFocus(id: string, kind: "entry" | "proposal") {
    const ids = kind === "entry" ? entryIds() : proposalIds();
    const index = ids.indexOf(id);
    pendingFocus = { gone: id, kind, next: ids[index + 1] ?? ids[index - 1] ?? null };
  }
  createEffect(() => {
    const ids = [...entryIds(), ...proposalIds()];
    const pending = pendingFocus;
    if (!pending || ids.includes(pending.gone)) return;
    pendingFocus = null;
    queueMicrotask(() => {
      const selector =
        pending.kind === "entry"
          ? `[data-entry-id="${pending.next}"] .memory-row-open`
          : `[data-proposal-id="${pending.next}"] .zb-kit-button`;
      const target = pending.next ? document.querySelector<HTMLElement>(selector) : null;
      (target ?? heading)?.focus();
    });
  });
  // An agent with nothing saved yet still shows as the filter, so the owner can clear it.
  const agents = createMemo(() => {
    const options = agentOptions(view(), t("memory.writer.agent"));
    const id = filter().agentId;
    return !id || options.some((option) => option.value === id)
      ? options
      : [...options, { value: id, label: t("memory.filter.thisAgent") }];
  });
  const projects = createMemo(() =>
    projectOptions(view(), t("memory.filter.everywhere"), t("memory.unknownProject")),
  );
  const update = (patch: Partial<MemoryFilter>) =>
    setFilter((current) => ({ ...current, ...patch }));
  const announce = (text: string) => {
    // Repeating the same text still reads it out.
    setAnnouncement("");
    queueMicrotask(() => setAnnouncement(text));
  };

  async function decide(proposal: MemoryProposal, decision: "accept" | "reject") {
    if (deciding().has(proposal.id)) return;
    setDeciding((ids) => new Set([...ids, proposal.id]));
    setDecideErrors(({ [proposal.id]: _, ...rest }) => rest);
    rememberFocus(proposal.id, "proposal");
    const failure = await props.store.decide(proposal.id, decision);
    setDeciding((ids) => new Set([...ids].filter((id) => id !== proposal.id)));
    if (failure) {
      pendingFocus = null;
      setDecideErrors((errors) => ({ ...errors, [proposal.id]: failure }));
      return;
    }
    // An agent's forget request reads the other way round: accepting forgets, rejecting keeps.
    const done = proposal.merges
      ? decision === "accept"
        ? "memory.review.merged"
        : "memory.review.keptBoth"
      : proposal.forget
        ? decision === "accept"
          ? "memory.entry.forgot"
          : "memory.review.notForgotten"
        : decision === "accept"
          ? "memory.review.kept"
          : "memory.review.discarded";
    announce(t(done, { title: proposal.title }));
  }

  const [tidySaving, setTidySaving] = createSignal(false);
  const [tidyError, setTidyError] = createSignal<string | null>(null);
  async function setTidy(on: boolean) {
    setTidySaving(true);
    setTidyError(null);
    setTidyError(await props.store.setTidy(on));
    setTidySaving(false);
  }

  const nothingSaved = () => !view().entries.length && !view().proposals.length;

  return (
    <main aria-label={t("memory.title")} class="map-panel memory-panel">
      <header class="window-drag map-header">
        <Show when={props.sidebarCollapsed}>
          <button
            type="button"
            class="sidebar-icon-button sidebar-restore-button no-drag"
            aria-label={t("memory.showSidebar")}
            aria-controls="bot-sidebar"
            aria-expanded="false"
            title={t("memory.showSidebar")}
            onClick={props.onShowSidebar}
          >
            <SidebarToggleIcon />
          </button>
        </Show>
        <h1 ref={heading} class="map-title tasks-title" tabIndex={-1}>
          {t("memory.title")}
        </h1>
      </header>
      <div class="tasks-body memory-body">
        <div class="memory-toolbar no-drag">
          <fieldset class="memory-views">
            <legend class="sr-only">{t("memory.filter.views")}</legend>
            <button
              type="button"
              class="memory-view"
              aria-pressed={!reviewing()}
              onClick={() => setReviewing(false)}
            >
              {t("memory.filter.all")}
            </button>
            <button
              type="button"
              class="memory-view"
              aria-pressed={reviewing()}
              onClick={() => setReviewing(true)}
            >
              {t("memory.filter.review")}
              <Show when={view().proposals.length}>
                <span class="memory-count">{view().proposals.length}</span>
              </Show>
            </button>
          </fieldset>
          <Show when={agents().length > 1 || filter().agentId}>
            <Select
              label={t("memory.filter.agent")}
              class="tasks-filter"
              value={filter().agentId}
              options={[{ value: "", label: t("memory.filter.anyAgent") }, ...agents()]}
              onChange={(agentId) => update({ agentId })}
            />
          </Show>
          <Show when={projects().length > 1}>
            <Select
              label={t("memory.filter.project")}
              class="tasks-filter"
              value={filter().projectId}
              options={[{ value: "", label: t("memory.filter.anyProject") }, ...projects()]}
              onChange={(projectId) => update({ projectId })}
            />
          </Show>
          <input
            type="search"
            class="zb-kit-input memory-search"
            aria-label={t("memory.search")}
            placeholder={t("memory.search")}
            value={filter().query}
            onInput={(event) => update({ query: event.currentTarget.value })}
          />
        </div>
        <output class="sr-only">{announcement()}</output>
        <Show when={props.store.error()}>
          {(message) => (
            <p class="tasks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={props.store.loaded()}>
          <Show when={!nothingSaved()} fallback={<p class="tasks-empty">{t("memory.empty")}</p>}>
            <Show
              when={reviewing()}
              fallback={
                <Show
                  when={entries().length}
                  fallback={<p class="tasks-empty">{t("memory.noMatch")}</p>}
                >
                  <ul class="memory-list">
                    <For each={entryIds()}>
                      {(id) => (
                        <Show when={entryById().get(id)}>
                          {(entry) => (
                            <MemoryEntryRow
                              entry={entry()}
                              store={props.store}
                              open={openId() === id}
                              onToggle={() => setOpenId(openId() === id ? null : id)}
                              onAnnounce={announce}
                              onRemoving={() => rememberFocus(id, "entry")}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </ul>
                </Show>
              }
            >
              <Show
                when={proposals().length}
                fallback={
                  <p class="tasks-empty">
                    {view().proposals.length ? t("memory.noMatch") : t("memory.noReview")}
                  </p>
                }
              >
                <ul class="memory-list">
                  <For each={proposalIds()}>
                    {(id) => (
                      <Show when={proposalById().get(id)}>
                        {(proposal) => (
                          <li class="memory-row memory-proposal" data-proposal-id={id}>
                            <div class="memory-proposal-head">
                              <span id={`memory-proposal-op-${id}`} class="memory-op">
                                {t(
                                  OP_KEYS[
                                    proposal().merges
                                      ? "merge"
                                      : proposal().forget
                                        ? "forget"
                                        : proposal().op
                                  ],
                                )}
                              </span>
                              <span id={`memory-proposal-${id}`} class="memory-row-title">
                                {proposal().title}
                              </span>
                            </div>
                            <p class="memory-body">{proposal().forget ?? proposal().body}</p>
                            <Show
                              when={proposal().merges}
                              fallback={
                                <Show when={proposal().reason}>
                                  <p class="memory-reason">{proposal().reason}</p>
                                </Show>
                              }
                            >
                              {(merges) => (
                                <div class="memory-merge">
                                  <p class="memory-merge-label" id={`memory-merge-${id}`}>
                                    {t("memory.review.replaces")}
                                  </p>
                                  <ul aria-labelledby={`memory-merge-${id}`}>
                                    <For each={[merges().keep, merges().drop].filter(Boolean)}>
                                      {(body) => <li>{body}</li>}
                                    </For>
                                  </ul>
                                </div>
                              )}
                            </Show>
                            <div class="memory-proposal-foot">
                              <span class="memory-row-meta">
                                {memoryMeta(proposal(), proposal().createdAt)}
                              </span>
                              <div class="memory-actions">
                                <button
                                  type="button"
                                  class="zb-kit-button primary"
                                  disabled={deciding().has(id)}
                                  aria-describedby={`memory-proposal-op-${id} memory-proposal-${id}`}
                                  onClick={() => void decide(proposal(), "accept")}
                                >
                                  {t(
                                    proposal().merges
                                      ? "memory.review.merge"
                                      : proposal().forget
                                        ? "memory.review.forget"
                                        : "memory.review.keep",
                                  )}
                                </button>
                                <button
                                  type="button"
                                  class="zb-kit-button"
                                  disabled={deciding().has(id)}
                                  aria-describedby={`memory-proposal-op-${id} memory-proposal-${id}`}
                                  onClick={() => void decide(proposal(), "reject")}
                                >
                                  {t(
                                    proposal().merges
                                      ? "memory.review.keepBoth"
                                      : proposal().forget
                                        ? "memory.review.dontForget"
                                        : "memory.review.discard",
                                  )}
                                </button>
                              </div>
                            </div>
                            <Show when={decideErrors()[id]}>
                              {(message) => (
                                <p class="memory-error" role="alert">
                                  {message()}
                                </p>
                              )}
                            </Show>
                          </li>
                        )}
                      </Show>
                    )}
                  </For>
                </ul>
              </Show>
              <label class="memory-tidy">
                <input
                  type="checkbox"
                  checked={view().tidy}
                  disabled={tidySaving()}
                  onChange={(event) => void setTidy(event.currentTarget.checked)}
                />
                {t("memory.review.tidy")}
              </label>
              <Show when={tidyError()}>
                {(message) => (
                  <p class="memory-error" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </main>
  );
}
