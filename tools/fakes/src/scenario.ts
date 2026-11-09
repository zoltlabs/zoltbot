import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Ajv } from "ajv";
import { parse } from "yaml";

interface Step {
  emit?: unknown;
  on_input?: { contains?: string; match?: Record<string, unknown> };
  reply?: { result?: unknown; error?: unknown };
  control_reply?: { subtype: "success" | "error"; response?: unknown; error?: string };
  sleep_ms?: number;
  crash?: boolean;
  hang?: boolean;
  malformed?: string;
}
interface Scenario {
  name: string;
  provider: string;
  steps: Step[];
  mode?: "normal" | "slow" | "crash" | "hang" | "malformed" | "unknown";
  crashAfter?: number;
}
function subset(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object")
    return (
      Boolean(actual) &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) => subset((actual as Record<string, unknown>)[k], v))
    );
  return actual === expected;
}
export async function runFake(provider: string) {
  const file = process.argv[2];
  if (!file) throw new Error("scenario path required");
  const scenario = parse(readFileSync(file, "utf8")) as Scenario;
  if (scenario.provider !== provider || !Array.isArray(scenario.steps))
    throw new Error("invalid scenario");
  const validator =
    provider === "codex"
      ? new Ajv({ strict: false }).compile(
          JSON.parse(
            readFileSync(
              process.env.FAKE_CODEX_SCHEMA ??
                new URL("../contracts/codex-client.json", import.meta.url),
              "utf8",
            ),
          ),
        )
      : undefined;
  const hang = () =>
    new Promise<void>(() => {
      setInterval(() => {}, 1000);
    });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const input = lines[Symbol.asyncIterator]();
  process.stderr.write("ZOLTBOT_FAKE_READY\n");
  let last: Record<string, unknown> = {};
  let emitted = 0;
  let initialized = false;
  let completedHandshake = false;
  const emit = (value: unknown) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    emitted++;
    if (scenario.mode === "crash" && emitted >= (scenario.crashAfter ?? 2)) process.exit(1);
  };
  if (scenario.mode === "unknown") emit({ type: "future_type", method: "future/unknown" });
  if (scenario.mode === "malformed") process.stdout.write("{malformed-json\n");
  if (scenario.mode === "hang") return hang();
  for (const step of scenario.steps) {
    if (step.on_input) {
      const line = await input.next();
      if (line.done) throw new Error("missing required client input");
      last = JSON.parse(line.value);
      if (validator && !validator(last)) throw new Error("client request failed schema validation");
      if (step.on_input.contains && !line.value.includes(step.on_input.contains))
        throw new Error("client input did not match expected content");
      if (step.on_input.match && !subset(last, step.on_input.match))
        throw new Error("client input did not match expected fields");
      if (provider === "codex" || provider === "acp") {
        if (last.method === "initialize") initialized = true;
        else if (provider === "codex" && last.method === "initialized") {
          if (!initialized) throw new Error("initialize must precede initialized");
          completedHandshake = true;
        } else if (!initialized || (provider === "codex" && !completedHandshake))
          throw new Error("handshake required before session commands");
      }
    }
    if (step.sleep_ms || scenario.mode === "slow")
      await new Promise((resolve) => setTimeout(resolve, step.sleep_ms ?? 20));
    if (step.emit !== undefined) emit(step.emit);
    if (step.reply) emit({ jsonrpc: "2.0", id: last.id, ...step.reply });
    if (step.control_reply) {
      if (
        provider !== "claude" ||
        last.type !== "control_request" ||
        typeof last.request_id !== "string"
      )
        throw new Error("control_request_required");
      emit({
        type: "control_response",
        response: { request_id: last.request_id, ...step.control_reply },
      });
    }
    if (step.malformed) process.stdout.write(`${step.malformed}\n`);
    if (step.crash) process.exit(1);
    if (step.hang) return hang();
  }
  lines.close();
}
