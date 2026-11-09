import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  connectStdio,
  RichToolResult,
  type ToolActor,
  type ToolInvocation,
  type ToolResult,
} from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api.js";
import { markTaint } from "../knowledge-taint.js";
import { consent } from "./approval.js";
import { checkedArgs, cuaGuidance, cuaTools, cuaWrites } from "./policy.js";

type Client = Awaited<ReturnType<typeof connectStdio>>;
type Run = {
  sessionId: string;
  approvalId: string;
  label: string;
  client?: Client;
  tools?: Awaited<ReturnType<Client["listTools"]>>["tools"];
  timer?: NodeJS.Timeout;
  observed: Set<string>;
  closing?: Promise<void>;
};
export class CuaRuntime {
  private run: Run | undefined;
  private busy = false;
  private closed = false;
  private cleanupError: string | undefined;
  constructor(
    private readonly context: RuntimeContext,
    private readonly options: {
      platform?: string;
      binary?: string;
      connect?: typeof connectStdio;
    } = {},
  ) {}

  private async binary() {
    if ((this.options.platform ?? process.platform) !== "darwin") throw Error("cua_requires_macos");
    const executable =
      this.options.binary ??
      process.env.ZOLTBOT_CUA_DRIVER_PATH ??
      path.join(homedir(), ".local/bin/cua-driver");
    if (!path.isAbsolute(executable)) throw Error("cua_binary_path_must_be_absolute");
    try {
      await access(executable, constants.X_OK);
    } catch {
      throw Error(
        "cua_setup_required: Install Cua Driver from https://cua.ai/docs/cua-driver, run cua-driver doctor and cua-driver permissions grant yourself, then retry. Custom installs: set ZOLTBOT_CUA_DRIVER_PATH to the absolute executable path before launching Zoltbot.",
      );
    }
    return executable;
  }

  private touch(run: Run) {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => {
      void this.release(run.sessionId).catch(() => {}); // release retains a status warning.
    }, 5 * 60_000);
    run.timer.unref();
  }

  release(sessionId: string): Promise<void> {
    const run = this.run;
    if (!run || run.sessionId !== sessionId) return Promise.resolve();
    run.closing ??= this.finish(run);
    return run.closing;
  }

  private async finish(run: Run) {
    // Retain the lock until the transport is closed, including when end_session fails.
    clearTimeout(run.timer);
    let released = !run.client;
    try {
      if (run.client) {
        try {
          await run.client.callTool(
            { name: "end_session", arguments: { session: run.label } },
            undefined,
            { timeout: 5000 },
          );
        } finally {
          await run.client.close();
          released = true;
        }
      }
    } catch {
      this.cleanupError =
        "cua_cleanup_unconfirmed: Driver session cleanup or transport closure could not be confirmed. Inspect the driver before starting another run.";
      throw Error(this.cleanupError);
    } finally {
      if (released && this.run === run) this.run = undefined;
      if (!released) delete run.closing;
    }
  }

  async close() {
    this.closed = true;
    if (this.run) await this.release(this.run.sessionId);
  }

  private active(actor: ToolActor) {
    return (
      this.context.store.record("session", actor.sessionId)?.state === "running" &&
      this.context.store.record("turn", actor.turnId ?? "")?.status === "running"
    );
  }

  call = async (call: ToolInvocation): Promise<unknown> => {
    if (this.closed) return { error: "cua_runtime_closed" };
    if (this.busy)
      return {
        error: "cua_busy",
        hint: "Wait for the in-flight call; never replay uncertain input.",
      };
    this.busy = true;
    try {
      return await this.perform(call);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message.slice(0, 1800) : "cua_failed",
        hint: "Do not replay input blindly. Refresh state after failures. Driver permission refusals cannot be bypassed.",
      };
    } finally {
      this.busy = false;
    }
  };

  private async perform(call: ToolInvocation): Promise<unknown> {
    const args = call.arguments as {
      action: string;
      tool?: string;
      args?: Record<string, unknown>;
    };
    if (args.action === "status") {
      const executable = await this.binary();
      return {
        state:
          this.run?.sessionId === call.actor.sessionId && this.run.client
            ? "connected"
            : "installed_not_connected",
        executable,
        permissions: "unchecked",
        approvalRequired: true,
        hint: "connect requests human consent before starting the signed CuaDriver helper; setup and macOS permissions belong to the user.",
        busy: !!this.run,
        ...(this.cleanupError ? { cleanupWarning: this.cleanupError } : {}),
      };
    }
    if (this.run && this.run.sessionId !== call.actor.sessionId)
      return {
        error: "cua_desktop_owned",
        hint: "Another Zoltbot chat owns native control. End that run or wait for its idle timeout.",
      };
    if (args.action === "end") {
      await this.release(call.actor.sessionId);
      return { state: "ended" };
    }
    if (this.run?.closing) throw Error("cua_cleanup_running");
    if (!this.run) {
      if (args.action !== "connect") return { error: "cua_connect_required" };
      await this.binary();
      this.run = {
        sessionId: call.actor.sessionId,
        approvalId: `cua-${randomUUID()}`,
        label: `zolt-${randomUUID()}`,
        observed: new Set(),
      };
    }
    const run = this.run;
    this.touch(run);
    const approval = consent(this.context, call.actor, run.approvalId);
    if (approval !== "approved")
      return {
        state: approval,
        interactionId: run.approvalId,
        hint: "Wait for the human answer. Call connect again after approval.",
      };
    if (!this.active(call.actor)) throw Error("cua_session_inactive");
    if (!run.client) {
      const executable = await this.binary();
      // Do not inherit CUA_DRIVER_* policy/socket overrides or provider credentials.
      const env = Object.fromEntries(
        ["HOME", "USER", "LOGNAME", "TMPDIR", "PATH"].flatMap((key) =>
          process.env[key] ? [[key, process.env[key] as string]] : [],
        ),
      );
      const client = await (this.options.connect ?? connectStdio)(executable, ["mcp"], env);
      if (this.run !== run || this.closed || !this.active(call.actor)) {
        await client.close();
        throw Error("cua_session_inactive");
      }
      run.client = client;
      try {
        run.tools = (await client.listTools({}, { timeout: 10000 })).tools;
        if (
          !["check_permissions", "end_session", "get_window_state", "list_windows"].every((name) =>
            run.tools?.some((tool) => tool.name === name),
          )
        )
          throw Error("cua_incompatible_driver");
      } catch (error) {
        await this.release(run.sessionId);
        throw error;
      }
    }
    if (args.action === "connect") {
      const permissions = await run.client.callTool(
        { name: "check_permissions", arguments: { prompt: false } },
        undefined,
        { timeout: 10000 },
      );
      return this.rich({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              state: "connected_check_permissions",
              tools: run.tools?.filter((tool) => cuaTools.has(tool.name)).map((tool) => tool.name),
              guidance: cuaGuidance,
            }),
          },
          ...(permissions.content as ToolResult["content"]),
        ],
        ...(permissions.isError ? { isError: true } : {}),
        ...(permissions.structuredContent
          ? { structuredContent: permissions.structuredContent as Record<string, unknown> }
          : {}),
      });
    }
    const definition = run.tools?.find(
      (tool) => tool.name === args.tool && cuaTools.has(tool.name),
    );
    if (!definition) throw Error("cua_tool_not_supported");
    if (args.action === "describe")
      return this.rich({ content: [{ type: "text", text: JSON.stringify(definition) }] });
    if (args.action !== "call") throw Error("cua_invalid_action");
    const input = checkedArgs(definition.name, args.args ?? {});
    const target = (input.target ?? input) as Record<string, unknown>;
    const window = `${target.pid}:${target.window_id}`;
    if (cuaWrites.has(definition.name)) {
      if (!run.observed.delete(window)) throw Error("cua_fresh_observation_required");
      let fresh = false;
      const receipt = createHash("sha256").update(call.idempotencyKey).digest("hex");
      this.context.store.dispatch(`cua-action:${receipt}`, () => {
        fresh = true;
        return { events: [], result: { attempted: true } };
      });
      if (!fresh) throw Error("cua_action_already_attempted_observe_before_continuing");
    }
    if (definition.inputSchema.properties && "session" in definition.inputSchema.properties)
      input.session = run.label;
    // No automatic retries: a timeout can mean input was already delivered.
    const result = await run.client.callTool(
      { name: definition.name, arguments: input },
      undefined,
      { timeout: 30000 },
    );
    markTaint(this.context.store, call.actor.sessionId, "connected_app", "native_app");
    if (definition.name === "get_window_state" && !result.isError) run.observed.add(window);
    this.touch(run);
    return this.rich({
      content: result.content as ToolResult["content"],
      ...(result.isError ? { isError: true } : {}),
      ...(result.structuredContent
        ? { structuredContent: result.structuredContent as Record<string, unknown> }
        : {}),
    });
  }

  private rich(result: ToolResult) {
    // Only text and inline images are supported by all production provider MCP adapters.
    return new RichToolResult({
      ...result,
      content: result.content.filter((item) => item.type === "text" || item.type === "image"),
    });
  }
}
