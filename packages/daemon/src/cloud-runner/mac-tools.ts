import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { RichToolResult, type ToolActor, type ToolInvocation } from "@zoltbot/hostmcp";
import { type HostToolDefinition, parse } from "@zoltbot/protocol";
import type { MacStatusResult } from "@zoltbot/runner-protocol";
import type { RunnerCalls } from "./calls.js";
import type { CloudToolSet, NativeCloudTasksOptions } from "./native.js";

const cwd = Type.Optional(Type.String({ maxLength: 4096 }));
const statusArgs = Type.Object({ cwd }, { additionalProperties: false });
const execArgs = Type.Object(
  {
    command: Type.String({ minLength: 1, maxLength: 16000 }),
    cwd,
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    stdin: Type.Optional(Type.String({ maxLength: 65536 })),
  },
  { additionalProperties: false },
);
export const cloudMacToolDefinitions: readonly HostToolDefinition[] = [
  {
    name: "mac_status",
    description:
      "Check whether the task member's Mac is online, its macOS version and project folder.",
    inputSchema: statusArgs,
  },
  {
    name: "mac_exec",
    description:
      "Run a shell command on the task member's Mac after approval. Output returns to this cloud task and the model provider. Timeout defaults to 600 seconds, with a maximum of 3600 seconds.",
    inputSchema: execArgs,
  },
];
type Input = Parameters<NativeCloudTasksOptions["tools"]>[0];
interface Transport extends Pick<RunnerCalls, "call"> {
  flush(taskId: string, signal: AbortSignal): Promise<void>;
}
const rich = (value: Record<string, unknown>, error = false) =>
  new RichToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...(error ? { isError: true as const } : {}),
  });
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("mac_unavailable"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 500);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
/** Offered only by cloud native hosts. Local runtime tool definitions do not include these tools. */
export function cloudMacTools(input: Input, transport: Transport): CloudToolSet {
  const execution = input.lease.execution;
  if (!execution || execution.task.location !== "sandbox") throw new Error("mac_tools_unavailable");
  const active = (actor: ToolActor) => {
    const session = input.store.record("session", actor.sessionId),
      turn = actor.turnId && input.store.record("turn", actor.turnId);
    return (
      !input.signal.aborted &&
      actor.agentId === execution.profile.id &&
      actor.threadId === execution.thread.id &&
      session?.threadId === actor.threadId &&
      session.state === "running" &&
      turn &&
      turn.sessionId === actor.sessionId &&
      turn.status === "running"
    );
  };
  const check = (call: ToolInvocation) => {
    if (!active(call.actor)) throw new Error("mac_unavailable");
  };
  const base = (call: ToolInvocation) => ({
    requestId: createHash("sha256")
      .update(JSON.stringify([input.lease.taskId, call.idempotencyKey]))
      .digest("hex"),
    taskId: input.lease.taskId,
    turnId: String(call.actor.turnId),
    userId: input.lease.actor.userId,
  });
  const status = async (
    call: ToolInvocation,
    cwd: string | undefined,
  ): Promise<MacStatusResult> => {
    check(call);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 1900);
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    let abort = () => {};
    try {
      const stopped = new Promise<MacStatusResult>((resolve) => {
        abort = () => resolve({ available: false, reason: "offline" });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      const work = (async () => {
        await input.assertPublic(call.arguments);
        if (signal.aborted) throw new Error("mac_unavailable");
        await transport.flush(input.lease.taskId, signal);
        if (signal.aborted) throw new Error("mac_unavailable");
        check(call);
        return transport.call(
          "mac.status.request",
          { ...base(call), ...(cwd !== undefined ? { cwd } : {}) },
          signal,
        );
      })();
      return await Promise.race([work, stopped]);
    } catch {
      return { available: false, reason: "offline" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
  const tools = new Map<string, (call: ToolInvocation) => Promise<unknown>>([
    [
      "mac_status",
      async (call) => {
        const args = parse(statusArgs, call.arguments),
          result = await status(call, args.cwd);
        if (!result.available) return rich(result);
        const { targetDeviceId: _target, ...visible } = result;
        return rich(visible);
      },
    ],
    [
      "mac_exec",
      async (call) => {
        const args = parse(execArgs, call.arguments);
        if (args.command.includes("\0") || Buffer.byteLength(args.stdin ?? "") > 65536)
          throw new Error("invalid_tool_arguments");
        const mac = await status(call, args.cwd);
        if (!mac.available)
          return rich(
            {
              error: mac.reason === "offline" ? "mac_offline" : "mac_unavailable",
              reason: mac.reason,
            },
            true,
          );
        const request = {
          ...base(call),
          command: args.command,
          cwd: mac.cwd,
          targetDeviceId: mac.targetDeviceId,
          ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
          ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
        };
        for (;;) {
          check(call);
          await input.assertPublic(request);
          const progress = await transport
            .call("mac.exec.request", request, input.signal)
            .catch(async (error: unknown) => {
              check(call);
              if (!(error instanceof Error) || error.message !== "runner_call_unavailable")
                throw new Error("mac_unavailable");
              await pause(input.signal);
              return undefined;
            });
          if (!progress) continue;
          if (progress.state === "denied") return rich({ error: `mac_${progress.reason}` }, true);
          if (progress.state === "complete") {
            await input.assertPublic(progress.result);
            const {
              requestId: _request,
              taskId: _task,
              stdoutBytes: _stdoutBytes,
              stderrBytes: _stderrBytes,
              ...result
            } = progress.result;
            return rich(result);
          }
          await pause(input.signal);
        }
      },
    ],
  ]);
  return {
    definitions: cloudMacToolDefinitions,
    tools,
    authorize: (actor, name) => Boolean(active(actor)) && tools.has(name),
    checkLimits: () => true,
    // CellMacRecords audits the durable request, approval, denial and result without tool arguments.
    audit: async () => {},
  };
}
