import {
  ContextPackSchema,
  type KnowledgeItem,
  KnowledgeItemSchema,
  parse,
} from "@zoltbot/protocol";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/primitives.js";
import {
  type ContextSectionProps,
  contextLabels,
  registerContextSection,
  TokenMeter,
} from "../context/SessionInputsPanel.js";
import { KnowledgeEditor } from "./Knowledge.js";

type Pack = ReturnType<typeof parse<typeof ContextPackSchema>>;
export function TaskKnowledgeContextSection({ connection, task, mode }: ContextSectionProps) {
  const [updatePreview, setUpdatePreview] = useState(false);
  const [draft, setDraft] = useState<KnowledgeItem>();
  const [confirmExclusion, setConfirmExclusion] = useState(false);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [readUsage, setReadUsage] = useState({ reads: 0, tokens: 0 });
  const [pack, setPack] = useState<Pack>(),
    [error, setError] = useState(""),
    [held, setHeld] = useState(false);
  const scope = useMemo(
    () => (task.id === "draft" ? task.node : { type: "task", id: String(task.id) }),
    [task.id, task.node],
  );
  const id = String(task.id),
    query = String(task.brief ?? ""),
    seq = [
      ...(connection.snapshot.entities.knowledge ?? []),
      ...(connection.snapshot.entities.contextPack ?? []),
      ...(connection.snapshot.entities.audit ?? []).filter(
        (row) => row.action === "host.team_get_knowledge" || row.action === "knowledge.sendUpdate",
      ),
    ]
      .map((row) => `${row.id}:${row.revision}`)
      .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: committed daemon events invalidate the inspector.
  useEffect(() => {
    let live = true;
    const request =
      mode === "preview"
        ? connection
            .call("knowledge.preview", { scope, query, remainingTokens: 1200 })
            .then((value) => {
              const result = value as { pack: unknown; held: boolean };
              return { pack: parse(ContextPackSchema, result.pack), held: result.held };
            })
        : connection.call("inspector.get", { taskId: id }).then((value) => {
            const result = value as { pack?: unknown; reads: unknown[]; injectedTokens: number };
            const frozen = parse(ContextPackSchema, result.pack);
            if (live)
              setReadUsage({
                reads: result.reads.length,
                tokens: result.injectedTokens - frozen.tokenEstimate,
              });
            return { pack: frozen, held: false };
          });
    request
      .then((result) => {
        if (live) {
          setPack(result.pack);
          setHeld(result.held);
          setError("");
        }
      })
      .catch(() => {
        if (live)
          setError(
            mode === "preview"
              ? "Could not preview knowledge. Check again before starting."
              : "No frozen knowledge pack reported for this execution.",
          );
      });
    return () => {
      live = false;
    };
  }, [connection.call, id, mode, scope, query, task.revision, seq]);
  const changed = pack?.included.some((item) =>
    (connection.snapshot.entities.knowledge ?? []).some(
      (row) => row.id === item.id && Number(row.revision) > item.revision,
    ),
  );
  const budgetHeld = held || String(task.holdReason ?? "").startsWith("context_budget_hold");
  const pinned = (connection.snapshot.entities.knowledge ?? []).filter(
    (row) =>
      row.pinned &&
      (pack?.included.some((item) => item.id === row.id) ||
        pack?.excluded.some((item) => item.id === row.id)),
  );
  const latest = (connection.snapshot.entities.knowledge ?? []).filter((row) =>
    pack?.included.some((item) => row.id === item.id && Number(row.revision) > item.revision),
  );
  return (
    <div>
      {changed ? (
        <Button onClick={() => setUpdatePreview(true)}>Send latest knowledge as a message…</Button>
      ) : null}
      {updatePreview ? (
        <section aria-label="Knowledge update preview">
          <h5>Send a visible update to this session</h5>
          <p>The original pack stays unchanged. This message adds counted context.</p>
          {latest.map((row) => (
            <p key={String(row.id)}>
              {String(row.title)} · v{String(row.revision)}: {String(row.body)}
            </p>
          ))}
          <Button
            onClick={async () => {
              try {
                await connection.call(
                  "knowledge.sendUpdate",
                  { taskId: id, ids: latest.map((row) => row.id), confirmed: true },
                  crypto.randomUUID(),
                );
                setUpdatePreview(false);
              } catch {
                setError("Could not send this update. Your knowledge and original pack are kept.");
              }
            }}
          >
            Send knowledge update
          </Button>
          <Button onClick={() => setUpdatePreview(false)}>Keep original context</Button>
        </section>
      ) : null}
      {task.state === "completed" || task.state === "review" ? (
        <Button
          onClick={async () => {
            try {
              setDraft(
                parse(
                  KnowledgeItemSchema,
                  await connection.call("knowledge.promoteDraft", {
                    taskId: id,
                    ...(window.getSelection()?.toString().trim()
                      ? { selectedText: window.getSelection()?.toString().trim() }
                      : {}),
                  }),
                ),
              );
            } catch {
              setError("Select assistant text of up to 1,200 characters to promote this finding.");
            }
          }}
        >
          Promote finding to knowledge
        </Button>
      ) : null}
      {draft ? (
        <KnowledgeEditor
          initial={draft}
          exists={false}
          connection={connection}
          close={() => setDraft(undefined)}
        />
      ) : null}
      {budgetHeld && pack ? (
        <div>
          <Button onClick={() => setConfirmExclusion(true)}>Exclude for this execution</Button>
          {confirmExclusion ? (
            <div>
              <p>Choose pinned entries to exclude for this execution. This choice is recorded.</p>
              {pinned.map((row) => (
                <label className="r" key={String(row.id)}>
                  <input
                    type="checkbox"
                    checked={excludedIds.includes(String(row.id))}
                    onChange={(event) =>
                      setExcludedIds((previous) =>
                        event.target.checked
                          ? [...previous, String(row.id)]
                          : previous.filter((id) => id !== row.id),
                      )
                    }
                  />
                  {String(row.title)}
                </label>
              ))}
              <Button
                onClick={async () => {
                  try {
                    await connection.call(
                      "knowledge.exclude",
                      {
                        taskId: id,
                        ids: excludedIds,
                        confirmed: true,
                      },
                      crypto.randomUUID(),
                    );
                    setConfirmExclusion(false);
                  } catch {
                    setError("Could not record the exclusion. Knowledge is kept.");
                  }
                }}
              >
                Confirm exclusion
              </Button>
              <Button onClick={() => setConfirmExclusion(false)}>Keep knowledge</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <output>{error}</output> : null}
      {changed ? <output>{contextLabels.changed}</output> : null}
      {budgetHeld ? (
        <p role="alert">
          Pinned knowledge does not fit. Edit knowledge or cancel this task before starting.
        </p>
      ) : null}
      {pack ? (
        <>
          <TokenMeter used={pack.tokenEstimate} budget={1200} />
          {readUsage.reads ? (
            <p className="dim sm">
              {readUsage.reads} knowledge reads or explicit updates · {readUsage.tokens} additional
              estimated tokens
            </p>
          ) : null}
          {mode === "preview" ? (
            <p className="dim sm">
              Provisional: connection and skill overhead may reduce the budget at dispatch.
            </p>
          ) : null}
          {!pack.included.length ? <p className="dim sm">No matching knowledge included.</p> : null}
          <ul>
            {pack.included.map((item) => (
              <li key={item.id}>
                <details>
                  <summary>
                    {item.id} · v{item.revision} · {item.tokens} tokens
                  </summary>
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {item.text}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
          {pack.excluded.length ? (
            <details>
              <summary>Excluded ({pack.excluded.length})</summary>
              <ul>
                {pack.excluded.map((item) => (
                  <li key={item.id}>
                    {item.id} · {item.reason.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
registerContextSection({
  id: "1-knowledge",
  title: "Knowledge",
  render: (props) => <TaskKnowledgeContextSection {...props} />,
});
