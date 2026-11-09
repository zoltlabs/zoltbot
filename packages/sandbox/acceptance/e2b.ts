import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Sandbox } from "e2b";
import { collect, type ExecutionTarget, type SandboxRef } from "../src/index.js";
import { createE2bTarget, SDK_VERSION } from "../src/targets/e2b/index.js";

// E2B acceptance checks for slice S1 (docs/cloud/sandboxes.md §2). Needs E2B_API_KEY in the
// environment; the key is passed to the SDK only and never printed or written to the report (I7).
//
//   E2B_API_KEY=… node --import tsx packages/sandbox/acceptance/e2b.ts [options]
//
// --template <name>          template to boot (default: SDK default "base", or E2B_TEMPLATE)
// --long-pause-minutes <n>   pause for the unanswered-question check (default 120)
// --skip-long                skip the long pause, recorded as not run
// --native                   run Claude Code and Codex native resume; needs the CLIs in the
//                            template and ANTHROPIC_API_KEY / OPENAI_API_KEY in the environment
// --vcpu-hour <usd> --gib-hour <usd>  prices for the cost estimate (third-party figures; confirm)

type Outcome = "passed" | "failed" | "not_run";
interface Check {
  id: string;
  outcome: Outcome;
  detail: string;
  measurements?: Record<string, number | string>;
}

const { values } = parseArgs({
  options: {
    template: { type: "string" },
    "long-pause-minutes": { type: "string", default: "120" },
    "skip-long": { type: "boolean", default: false },
    native: { type: "boolean", default: false },
    "vcpu-hour": { type: "string", default: "0.05" },
    "gib-hour": { type: "string", default: "0.016" },
  },
});

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) {
  process.stderr.write("E2B_API_KEY is not set; no E2B acceptance check was run.\n");
  process.exit(2);
}
const template = values.template ?? process.env.E2B_TEMPLATE;
const target = createE2bTarget({
  apiKey,
  timeoutMs: 3 * 3_600_000,
  ...(template ? { template } : {}),
});
const checks: Check[] = [];
const created: SandboxRef[] = [];
const secrets = [apiKey, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY].filter(
  (value): value is string => Boolean(value),
);

function scrub(text: string) {
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}
function record(check: Check) {
  const safe = { ...check, detail: scrub(check.detail) };
  checks.push(safe);
  process.stdout.write(`${safe.outcome.padEnd(8)} ${safe.id}: ${safe.detail}\n`);
}
async function attempt(id: string, work: () => Promise<Omit<Check, "id">>) {
  try {
    record({ id, ...(await work()) });
  } catch (error) {
    record({
      id,
      outcome: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await work();
  return [value, Math.round(performance.now() - started)];
}
async function sh(
  t: ExecutionTarget,
  ref: SandboxRef,
  script: string,
  env?: Record<string, string>,
) {
  return collect(await t.exec(ref, ["sh", "-c", script], env ? { env } : {}));
}
async function create(env?: Record<string, string>) {
  const ref = await target.create(env ? { env } : {});
  created.push(ref);
  return ref;
}
const median = (list: number[]) =>
  [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0;

try {
  await attempt("create_time", async () => {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [ref, ms] = await timed(async () => {
        const made = await create();
        await sh(target, made, "true");
        return made;
      });
      times.push(ms);
      await target.destroy(ref);
    }
    return {
      outcome: "passed",
      detail: `create to first command, median ${median(times)} ms of ${times.join(", ")}`,
      measurements: { medianMs: median(times), runs: times.join(",") },
    };
  });

  const stores = [
    ".claude/projects/zoltbot-acceptance/session.jsonl",
    ".codex/sessions/2026/11/06/rollout-acceptance.jsonl",
  ];
  await attempt("resume_time_and_session_stores", async () => {
    const ref = await create();
    const content = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ turn: i, text: "x".repeat(200) }),
    ).join("\n");
    const digest = createHash("sha256").update(content).digest("hex");
    for (const file of stores) await target.files.write(ref, file, content);
    const pid = (await sh(target, ref, "sleep 3600 >/dev/null 2>&1 & echo $!")).stdout.trim();
    const [, pauseMs] = await timed(() => target.sleep(ref));
    const [, resumeMs] = await timed(() => target.wake(ref));
    const [, firstMs] = await timed(() => sh(target, ref, "true"));
    const sums = await sh(target, ref, `sha256sum ${stores.map((s) => `"$HOME/${s}"`).join(" ")}`);
    const intact = sums.stdout
      .split("\n")
      .filter(Boolean)
      .every((line) => line.startsWith(digest));
    const alive = (await sh(target, ref, `kill -0 ${pid}`)).code === 0;
    await target.destroy(ref);
    return {
      outcome: intact && alive ? "passed" : "failed",
      detail: `pause ${pauseMs} ms, resume ${resumeMs} ms, first command after resume ${firstMs} ms; ~/.claude and ~/.codex stores ${intact ? "intact" : "changed"}; process ${alive ? "survived" : "lost"}`,
      measurements: { pauseMs, resumeMs, firstCommandMs: firstMs },
    };
  });

  const minutes = Number(values["long-pause-minutes"]);
  if (values["skip-long"])
    record({
      id: "unanswered_question_long_pause",
      outcome: "not_run",
      detail: "skipped with --skip-long",
    });
  else
    await attempt("unanswered_question_long_pause", async () => {
      // A process blocked on input stands in for a CLI waiting on a question; the real CLI version
      // runs once zolt-worker exists (S2).
      const ref = await create();
      // Detached and writing to a file, because a command stream is not expected to outlive a pause.
      await sh(
        target,
        ref,
        'mkfifo "$HOME/answer" && (read reply < "$HOME/answer"; echo "answered: $reply" > "$HOME/answered.txt") >/dev/null 2>&1 &',
      );
      await target.sleep(ref);
      await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
      const [, resumeMs] = await timed(() => target.wake(ref));
      await sh(target, ref, 'echo yes > "$HOME/answer"');
      let answered = "";
      for (let i = 0; i < 30 && !answered.includes("answered: yes"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        answered = (await sh(target, ref, 'cat "$HOME/answered.txt" 2>/dev/null')).stdout;
      }
      await target.destroy(ref);
      const ok = answered.includes("answered: yes");
      return {
        outcome: ok ? "passed" : "failed",
        detail: `paused ${minutes} min with a process blocked on input; resume ${resumeMs} ms; ${ok ? "the process finished after the answer" : "the process did not finish"}`,
        measurements: { pauseMinutes: minutes, resumeMs },
      };
    });

  const nativeNeeds = [
    !values.native && "--native",
    !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY",
    !process.env.OPENAI_API_KEY && "OPENAI_API_KEY",
  ].filter(Boolean);
  if (nativeNeeds.length) {
    const reason = `needs ${nativeNeeds.join(", ")} and a template with the claude and codex CLIs`;
    record({ id: "native_resume_after_resume", outcome: "not_run", detail: reason });
    record({
      id: "cost_per_task_hour",
      outcome: "not_run",
      detail: `measured from the native runs; ${reason}`,
    });
  } else {
    const env = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    };
    const ref = await create(env);
    const started = performance.now();
    await attempt("native_resume_after_resume", async () => {
      const claude = await sh(
        target,
        ref,
        "claude -p 'Remember the word kiwi. Reply with ok.' --output-format json",
      );
      const claudeId = (JSON.parse(claude.stdout || "{}") as { session_id?: string }).session_id;
      const codex = await sh(
        target,
        ref,
        "codex exec --skip-git-repo-check --json 'Remember the word kiwi. Reply with ok.'",
      );
      const codexId = codex.stdout
        .split("\n")
        .map((line) => {
          try {
            return (JSON.parse(line) as { thread_id?: string }).thread_id;
          } catch {
            return undefined;
          }
        })
        .find(Boolean);
      if (!claudeId || !codexId)
        return {
          outcome: "failed",
          detail: `first turns failed: claude exit ${claude.code}, codex exit ${codex.code}`,
        };
      await target.sleep(ref);
      await target.wake(ref);
      const ask = "Which word did I ask you to remember? Reply with the word only.";
      const claudeAgain = await sh(target, ref, `claude -p --resume ${claudeId} '${ask}'`);
      const codexAgain = await sh(
        target,
        ref,
        `codex exec --skip-git-repo-check resume ${codexId} '${ask}'`,
      );
      const claudeOk = /kiwi/i.test(claudeAgain.stdout);
      const codexOk = /kiwi/i.test(codexAgain.stdout);
      return {
        outcome: claudeOk && codexOk ? "passed" : "failed",
        detail: `after pause and resume: Claude Code ${claudeOk ? "resumed" : "did not resume"}, Codex ${codexOk ? "resumed" : "did not resume"}`,
      };
    });
    await attempt("cost_per_task_hour", async () => {
      const info = await Sandbox.getInfo(ref.id, { apiKey });
      const vcpu = Number(values["vcpu-hour"]);
      const gib = Number(values["gib-hour"]);
      const hourly = info.cpuCount * vcpu + (info.memoryMB / 1024) * gib;
      const minutesUsed = (performance.now() - started) / 60_000;
      return {
        outcome: "passed",
        detail: `${info.cpuCount} vCPU, ${info.memoryMB} MB: $${hourly.toFixed(3)} per running hour at the given prices; native runs took ${minutesUsed.toFixed(1)} min`,
        measurements: {
          cpuCount: info.cpuCount,
          memoryMB: info.memoryMB,
          usdPerHour: Number(hourly.toFixed(4)),
        },
      };
    });
  }
} finally {
  for (const ref of created) await target.destroy(ref).catch(() => undefined);
  const report = {
    target: "e2b",
    sdk: SDK_VERSION,
    template: template ?? "base",
    ranAt: new Date().toISOString(),
    checks,
  };
  const folder = path.resolve(".cache/sandbox-acceptance");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `e2b-${report.ranAt.replaceAll(":", "-")}.json`);
  await writeFile(file, `${scrub(JSON.stringify(report, null, 2))}\n`);
  process.stdout.write(`Report: ${file}\n`);
  if (checks.some((check) => check.outcome === "failed")) process.exitCode = 1;
}
