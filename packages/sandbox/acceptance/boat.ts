import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { collect, type SandboxRef } from "../src/index.js";
import {
  BOAT_HOURLY_RATES,
  BOAT_TEMPLATE,
  boatRequest,
  createBoatApi,
  createBoatTarget,
  SDK_VERSION,
} from "../src/targets/boat/index.js";

interface Check {
  id: string;
  outcome: "passed" | "failed" | "not_run";
  detail: string;
  measurements?: Record<string, number | string>;
}

const { values } = parseArgs({
  options: {
    template: { type: "string" },
    "skip-long": { type: "boolean" },
    "long-pause-minutes": { type: "string", default: "120" },
    native: { type: "boolean" },
    "us-region": { type: "string" },
  },
});
const apiKey = process.env.BOAT_API_KEY;
if (!apiKey) {
  process.stderr.write("BOAT_API_KEY is not set. No Boat acceptance checks ran.\n");
  process.exit(2);
}
const minutes = Number(values["long-pause-minutes"]);
if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
  process.stderr.write("The long pause must be between 0 and 1440 minutes.\n");
  process.exit(2);
}
const usRegion = values["us-region"];
if (usRegion && !/^[a-z]{2}-[a-z]+[0-9]?$/.test(usRegion)) {
  process.stderr.write("Supply a US runner region such as us-central1.\n");
  process.exit(2);
}
const template = values.template ?? process.env.BOAT_TEMPLATE ?? BOAT_TEMPLATE;
const target = createBoatTarget({ apiKey, template, ttlSeconds: 10_800 });
const api = createBoatApi(apiKey);
const checks: Check[] = [];
const refs = new Set<SandboxRef>();

function record(check: Check) {
  checks.push(check);
  process.stdout.write(`${check.outcome.padEnd(8)} ${check.id} — ${check.detail}\n`);
}

async function attempt(id: string, work: () => Promise<Omit<Check, "id">>) {
  try {
    record({ id, ...(await work()) });
  } catch {
    // Never report raw stdout, stderr, SDK errors, provider IDs or signed URLs.
    record({ id, outcome: "failed", detail: "The check could not complete." });
  }
}

async function run(ref: SandboxRef, argv: string[], env?: Record<string, string>) {
  const result = await collect(await target.exec(ref, argv, env ? { env } : {}));
  if (result.code !== 0) throw new Error("Acceptance command failed");
  return result.stdout;
}

async function using<T>(work: (ref: SandboxRef, createMs: number) => Promise<T>) {
  const start = performance.now();
  const ref = await target.create();
  refs.add(ref);
  try {
    await run(ref, ["true"]);
    return await work(ref, Math.round(performance.now() - start));
  } finally {
    await target.destroy(ref);
    refs.delete(ref);
  }
}

function median(list: number[]) {
  return [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;
}

function parseLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sessionId(value: unknown) {
  if (typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)) return value;
  throw new Error("Missing native session ID");
}

const ask = "Which word did I ask you to remember? Reply with the word only.";
const claudeKey = process.env.ANTHROPIC_API_KEY;
const codexKey = process.env.OPENAI_API_KEY;

try {
  await attempt("create_time", async () => {
    const times = [];
    for (let i = 0; i < 3; i++) times.push(await using(async (_ref, createMs) => createMs));
    return {
      outcome: "passed",
      detail: `Create to first command median ${median(times)} ms.`,
      measurements: { medianMs: median(times), runs: times.join(",") },
    };
  });

  await attempt("template_saved_snapshot", () =>
    using(async (ref) => {
      await run(ref, ["sh", "/opt/zoltbot/templates/sandbox/verify.sh"]);
      return {
        outcome: "passed",
        detail: "A sandbox from the saved snapshot ran the shared verification script.",
      };
    }),
  );

  await attempt("resume_time_and_session_stores", () =>
    using(async (ref) => {
      const paths = [
        ".claude/projects/zoltbot-acceptance/session.jsonl",
        ".codex/sessions/zoltbot-acceptance.jsonl",
      ];
      const data = Array.from({ length: 200 }, (_, turn) =>
        JSON.stringify({ turn, text: "x".repeat(200) }),
      ).join("\n");
      const digest = (value: string | Uint8Array) =>
        createHash("sha256").update(value).digest("hex");
      for (const path of paths) await target.files.write(ref, path, data);
      const program =
        "process.title = 'node /opt/zoltbot/apps/worker/dist/main.mjs'; console.log(process.pid); setInterval(() => {}, 1000)";
      const old = await target.exec(ref, ["node", "-e", program]);
      const first = await old[Symbol.asyncIterator]().next();
      if (first.done || !/^\d+\s*$/.test(first.value.data))
        throw new Error("Worker stand-in did not start");
      const stoppedAt = performance.now();
      await target.sleep(ref);
      const resumedAt = performance.now();
      await target.wake(ref);
      const readyAt = performance.now();
      await run(ref, [
        "sh",
        "-c",
        "! pgrep -f '^node /opt/zoltbot/apps/worker/dist/main\\.mjs$' >/dev/null",
      ]);
      const firstCommandAt = performance.now();
      const intact = (await Promise.all(paths.map((path) => target.files.read(ref, path)))).every(
        (value) => digest(value) === digest(data),
      );
      return {
        outcome: intact ? "passed" : "failed",
        detail: intact
          ? "Both session stores survived and the prior worker had exited."
          : "One or both session stores changed.",
        measurements: {
          pauseMs: Math.round(resumedAt - stoppedAt),
          resumeMs: Math.round(readyAt - resumedAt),
          firstCommandMs: Math.round(firstCommandAt - readyAt),
        },
      };
    }),
  );

  if (usRegion?.startsWith("us-")) {
    await attempt("us_to_eu_round_trip", () =>
      using(async (ref) => {
        const times = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          const result = await boatRequest(() =>
            api.command({ sandboxId: ref.id, command: "true", timeoutSeconds: 30 }),
          );
          if (!("exitCode" in result) || result.exitCode !== 0)
            throw new Error("Could not measure the round trip");
          times.push(Math.round(performance.now() - start));
        }
        return {
          outcome: "passed",
          detail: `Median ${median(times)} ms from the ${usRegion} test runner to Boat and back.`,
          measurements: { medianMs: median(times), runs: times.join(",") },
        };
      }),
    );
  } else {
    record({
      id: "us_to_eu_round_trip",
      outcome: "not_run",
      detail: "Run from a US host and supply its region with --us-region.",
    });
  }

  if (values["skip-long"] || !values.native || !claudeKey) {
    record({
      id: "unanswered_question_long_pause",
      outcome: "not_run",
      detail: "Requires --native, an Anthropic key and the full pause.",
    });
  } else {
    await attempt("unanswered_question_long_pause", () =>
      using(async (ref) => {
        const env = { ANTHROPIC_API_KEY: claudeKey };
        const label = `example-${randomUUID().slice(0, 8)}`;
        const prompt = `Remember the example label ${label}. Ask me only which color to use for it and wait for my next message.`;
        const first = JSON.parse(
          await run(ref, ["claude", "-p", "--output-format", "json", prompt], env),
        );
        if (!/which color[^?]*\?/i.test(first.result ?? ""))
          throw new Error("The agent did not ask the expected question");
        const id = sessionId(first.session_id);
        await target.sleep(ref);
        await delay(minutes * 60_000);
        const before = performance.now();
        await target.wake(ref);
        const resumeMs = Math.round(performance.now() - before);
        const answer = `blue-${randomUUID().slice(0, 8)}`;
        const final = await run(
          ref,
          [
            "claude",
            "-p",
            "--resume",
            id,
            `Use ${answer}. Reply with the original example label and the chosen color.`,
          ],
          env,
        );
        return {
          outcome:
            final.includes(answer) && final.includes(label) && minutes >= 120 ? "passed" : "failed",
          detail: `Resumed the unanswered Claude session after ${minutes} minutes and checked its response to the answer.`,
          measurements: { pauseMinutes: minutes, resumeMs },
        };
      }),
    );
  }

  if (!values.native || !claudeKey || !codexKey) {
    for (const id of ["native_resume_after_resume", "cost_per_task_hour"]) {
      record({ id, outcome: "not_run", detail: "Requires --native and both provider keys." });
    }
  } else {
    await attempt("native_resume_after_resume", () =>
      using(async (ref) => {
        const claudeEnv = { ANTHROPIC_API_KEY: claudeKey };
        const codexEnv = { OPENAI_API_KEY: codexKey };
        const word = `kiwi-${randomUUID().slice(0, 8)}`;
        const prompt = `Remember the word ${word}. Reply with OK.`;
        const claude = JSON.parse(
          await run(ref, ["claude", "-p", "--output-format", "json", prompt], claudeEnv),
        );
        const codex = parseLines(
          await run(ref, ["codex", "exec", "--skip-git-repo-check", "--json", prompt], codexEnv),
        );
        const claudeId = sessionId(claude.session_id);
        const codexId = sessionId(
          codex.find((event) => event.type === "thread.started")?.thread_id,
        );
        await target.sleep(ref);
        await target.wake(ref);
        const a = await run(ref, ["claude", "-p", "--resume", claudeId, ask], claudeEnv);
        const b = await run(
          ref,
          ["codex", "exec", "resume", "--skip-git-repo-check", codexId, ask],
          codexEnv,
        );
        await target.sleep(ref);
        await attempt("cost_per_task_hour", async () => {
          const usage = await boatRequest(() => api.usage({ sandboxId: ref.id }));
          const rate = BOAT_HOURLY_RATES[usage.sandboxType as keyof typeof BOAT_HOURLY_RATES];
          if (!rate || usage.seconds <= 0) throw new Error("Usage is unavailable");
          const observed = (usage.dollars * 3600) / usage.seconds;
          return {
            outcome:
              Math.abs(observed - rate) <= Math.max(0.001, rate * 0.05) ? "passed" : "failed",
            detail:
              "Compared Boat's measured VM cost for the native runs with the published hourly rate.",
            measurements: {
              runningSeconds: usage.seconds,
              chargedUsd: usage.dollars,
              observedUsdPerHour: observed,
              publishedUsdPerHour: rate,
            },
          };
        });
        return {
          outcome: a.includes(word) && b.includes(word) ? "passed" : "failed",
          detail:
            "After stop and resume, checked whether both native sessions recalled the original word.",
        };
      }),
    );
    if (!checks.some((check) => check.id === "cost_per_task_hour")) {
      record({
        id: "cost_per_task_hour",
        outcome: "not_run",
        detail: "Native runs did not complete.",
      });
    }
  }
} finally {
  for (const ref of refs) {
    await target.destroy(ref).catch(() => {
      record({
        id: "sandbox_cleanup",
        outcome: "failed",
        detail: "A disposable sandbox could not be deleted.",
      });
    });
  }
  const report = {
    target: "boat",
    sdk: SDK_VERSION,
    template,
    ranAt: new Date().toISOString(),
    checks,
  };
  const folder = ".cache/sandbox-acceptance";
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const filename = join(folder, `boat-${report.ranAt.replaceAll(":", "-")}.json`);
  await writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Report written to ${filename}.\n`);
  if (checks.some((check) => check.outcome !== "passed")) process.exitCode = 1;
}
