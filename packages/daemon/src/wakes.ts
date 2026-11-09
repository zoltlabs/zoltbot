import { createHash, randomUUID } from "node:crypto";
import {
  activeWake,
  type CommandContext,
  cancelWake,
  type DomainState,
  fireWake,
  localWakeMatch,
  type Outcome,
  saveWake,
  selectedWake,
  wakeEvent,
} from "@zoltbot/core";
import { parse, type Wake, type WakeInput, WakeSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { type GitHubTransport, ghTransport } from "../../github/src/transport.js";
import { eventRecord } from "./event-sources.js";

/** One-shot chat waits. Reconcile exact source state, including after sleeping/restarting. */
export function wakeService(options: {
  store: Store;
  publish(events: import("@zoltbot/protocol").DomainEvent[]): void;
  wake(threadId: string): Promise<void>;
  checkPublic(value: unknown): Promise<(state: DomainState) => void>;
  now?(): string;
  transport?: GitHubTransport;
  pollMs?: number;
  onError(code: string): void;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const transport = options.transport ?? ghTransport;
  let running: Promise<void> | undefined,
    closed = false;
  const run = (
    id: string,
    work: (state: DomainState, context: CommandContext) => Outcome,
    human = false,
  ) => {
    const before = options.store.lastSeq();
    const result = options.store.dispatch(id, (state) =>
      work(state, {
        commandId: id,
        at: now(),
        actor: { kind: human ? "human" : "system", id: "local-owner" },
      }),
    );
    options.publish(options.store.eventsSince(before));
    return result.result;
  };
  async function github(wake: Wake, bind = false) {
    const c = wake.condition;
    if (c.kind !== "pr" && c.kind !== "ci") return undefined;
    const get = async (endpoint: string) =>
      eventRecord(await transport(endpoint, "GET", undefined, AbortSignal.timeout(10000)));
    const account = await get("/user"),
      repository = await get(`/repos/${c.repository}`);
    if (
      !Number.isSafeInteger(account.id) ||
      !Number.isSafeInteger(repository.id) ||
      String(repository.full_name).toLowerCase() !== c.repository.toLowerCase()
    )
      throw new Error("wake_identity_unverified");
    if (!bind && (String(account.id) !== c.accountId || String(repository.id) !== c.repositoryId))
      throw new Error("wake_identity_changed");
    const condition = { ...c, accountId: String(account.id), repositoryId: String(repository.id) };
    let match: { reason: string; evidenceUrl: string } | undefined;
    if (c.kind === "pr") {
      const pr = await get(`/repos/${c.repository}/pulls/${c.number}`);
      if (pr.number !== c.number || typeof pr.merged !== "boolean")
        throw new Error("wake_source_invalid");
      if (pr.merged)
        match = {
          reason: `${c.repository}#${c.number} merged`,
          evidenceUrl: `https://github.com/${c.repository}/pull/${c.number}`,
        };
      else if (pr.state === "closed") throw new Error("wake_pr_closed_without_merge");
    } else {
      const ci = await get(`/repos/${c.repository}/actions/runs/${c.runId}/attempts/${c.attempt}`);
      if (String(ci.id) !== c.runId || ci.run_attempt !== c.attempt)
        throw new Error("wake_source_invalid");
      if (ci.status === "completed" && typeof ci.conclusion === "string") {
        if (c.outcome === "finished" || ci.conclusion === "success")
          match = {
            reason: `CI run ${c.runId}, attempt ${c.attempt}: ${ci.conclusion}`,
            evidenceUrl: `https://github.com/${c.repository}/actions/runs/${c.runId}/attempts/${c.attempt}`,
          };
        else throw new Error("wake_ci_did_not_pass");
      }
    }
    return { condition, match };
  }
  async function tickWork() {
    for (const raw of options.store.snapshot(["wake"]).wake ?? []) {
      if (closed) return;
      const wake = parse(WakeSchema, raw);
      if (!activeWake(wake) && wake.status !== "queued") continue;
      const thread = options.store.record("thread", wake.threadId);
      if (!thread || thread.archived) {
        if (activeWake(wake))
          run(`wake:cancel:${wake.id}:${wake.revision}`, (s, ctx) =>
            cancelWake(s, wake.id, wake.revision, ctx),
          );
        continue;
      }
      if (wake.status === "needs_attention" && wake.reason) continue;
      if (wake.status === "queued") {
        const item = options.store.record("item", wake.itemId ?? "");
        const status = (item?.body as { queueState?: string } | undefined)?.queueState;
        if (["sent", "handled", "failed", "uncertain"].includes(status ?? "")) {
          run(`wake:settled:${wake.id}:${wake.revision}`, (s, ctx) => {
            const current = selectedWake(s, wake.id, wake.revision);
            const next: Wake = {
              ...current,
              status: status === "sent" || status === "handled" ? "consumed" : "needs_attention",
              ...(status === "failed" || status === "uncertain"
                ? { error: "Continuation needs review; inspect the saved message before retrying" }
                : {}),
              revision: current.revision + 1,
              updatedAt: ctx.at,
            };
            return { events: [wakeEvent(next, ctx)], result: next };
          });
        } else if (status === "queued") {
          try {
            await options.wake(wake.threadId);
          } catch {
            options.onError("wake_runtime_unavailable");
          }
        }
        continue;
      }
      // Delivery failures are reviewed, never automatically resent.
      if (wake.itemId) continue;
      let match = localWakeMatch(options.store.snapshot(), wake),
        error: string | undefined;
      if (!match && wake.status !== "ready" && Date.parse(wake.fallbackAt) > Date.parse(now())) {
        try {
          match = (await github(wake))?.match;
        } catch {
          error =
            "Source unavailable or changed. Check the source and sign-in, then edit this wait.";
        }
      }
      if (!match && !error && wake.condition.kind === "job") {
        const jobs = options.store.record("session", wake.condition.sessionId)?.background as
          | { id: string; state: string }[]
          | undefined;
        const job = jobs?.find((j) => j.id === (wake.condition as { jobId: string }).jobId);
        if (!job)
          error =
            "The tracked job is no longer available. Inspect the source or edit this wait; the fallback remains scheduled.";
        else if (wake.condition.outcome === "passed" && ["failed", "stopped"].includes(job.state))
          error =
            "This job ended without success. Inspect its result or choose another run; the fallback remains scheduled.";
      }
      if (closed) return;
      // A remote check can race an edit or cancellation. The transaction rechecks the revision.
      const current = options.store.record("wake", wake.id);
      if (current?.revision !== wake.revision) continue;
      const outcome = run(
        `wake:check:${wake.id}:${wake.revision}:${randomUUID()}`,
        (state, ctx) => {
          const result = fireWake(state, wake.id, wake.revision, ctx, match);
          if (result.events.length) return result;
          const old = selectedWake(state, wake.id, wake.revision);
          if (!error) delete old.error;
          const next: Wake = {
            ...old,
            lastCheckedAt: ctx.at,
            ...(error
              ? { error, status: "needs_attention" as const }
              : { status: "waiting" as const }),
            revision: old.revision,
            updatedAt: ctx.at,
          };
          return { events: [wakeEvent(next, ctx)], result: next };
        },
      ) as Wake;
      if (outcome.status === "queued") {
        try {
          await options.wake(wake.threadId);
        } catch {
          options.onError("wake_runtime_unavailable");
        }
      }
    }
  }
  function tick() {
    if (closed) return Promise.resolve();
    running ??= tickWork()
      .catch(() => options.onError("wake_check_failed"))
      .finally(() => {
        running = undefined;
      });
    return running;
  }
  const timer = setInterval(() => {
    void tick();
  }, options.pollMs ?? 15000);
  timer.unref();
  queueMicrotask(() => {
    void tick();
  });
  return {
    tick,
    async api(method: string, params: Record<string, unknown>, commandId?: string) {
      if (!method.startsWith("wake.")) return undefined;
      if (!commandId) throw new Error("command_id_required");
      const receipt = options.store.receipt(commandId);
      if (receipt) return receipt.result;
      if (method === "wake.save") {
        let input = params.input as WakeInput;
        // Validate before network access and reject a forged source identity by always rebinding.
        const draftId = String(
          params.id ?? `wake:${createHash("sha256").update(commandId).digest("hex").slice(0, 24)}`,
        );
        const provisional = saveWake(
          options.store.snapshot(),
          input,
          draftId,
          { commandId, at: now(), actor: { kind: "human", id: "local-owner" } },
          params.revision as number | undefined,
        ).result as Wake;
        const source = await github(provisional, true);
        if (source) input = { ...input, condition: source.condition };
        const check = await options.checkPublic(input);
        const result = run(
          commandId,
          (state, ctx) => {
            check(state);
            return saveWake(state, input, draftId, ctx, params.revision as number | undefined);
          },
          true,
        );
        void tick();
        return result;
      }
      if (method === "wake.cancel")
        return run(
          commandId,
          (s, ctx) => cancelWake(s, String(params.id), Number(params.revision), ctx),
          true,
        );
      if (method === "wake.resumeNow") {
        const result = run(
          commandId,
          (s, ctx) => fireWake(s, String(params.id), Number(params.revision), ctx, undefined, true),
          true,
        );
        void tick();
        return result;
      }
      throw new Error("wake_method_unavailable");
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
