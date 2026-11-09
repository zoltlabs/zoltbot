import type { AgentEvent, BackgroundTask } from "@zoltbot/protocol";

type Frame = Record<string, unknown>;
const text = (value: unknown, limit = 2000) =>
  typeof value === "string" && value ? value.slice(0, limit) : undefined;
const id = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
const states = ["completed", "failed", "stopped"] as const;
const maxTasks = 50;
// Claude 2.1.42 tells the model where a backgrounded shell writes. Structured
// tool_use_result.backgroundTaskId is preferred when present.
const shellNotice =
  /Command (?:running in background|was manually backgrounded by user) with ID: ([^\s.]+)/;
const outputNotice = /Output is being written to: (\S+)/;

/** Background shell and agent tasks for one Claude session. Frames can arrive between turns. */
export class ClaudeBackground {
  private readonly tasks = new Map<string, BackgroundTask>();
  constructor(private readonly now = () => new Date().toISOString()) {}
  get(taskId: string) {
    return this.tasks.get(taskId);
  }
  running() {
    return [...this.tasks.values()].filter((task) => task.state === "running");
  }
  private update(task: BackgroundTask): AgentEvent[] {
    this.tasks.delete(task.id);
    this.tasks.set(task.id, task);
    // Bound memory: forget the oldest finished tasks first.
    for (const [key, value] of this.tasks) {
      if (this.tasks.size <= maxTasks) break;
      if (value.state !== "running") this.tasks.delete(key);
    }
    return [{ t: "background.updated", task: structuredClone(task) }];
  }
  private kind(frame: Frame, previous?: BackgroundTask): BackgroundTask["kind"] {
    const type = typeof frame.task_type === "string" ? frame.task_type : "";
    if (/bash|shell/i.test(type)) return "shell";
    if (/agent/i.test(type)) return "agent";
    return previous?.kind ?? "other";
  }
  /** system task_started, task_progress, and task_notification frames. Unknown fields are ignored. */
  system(frame: Frame): AgentEvent[] {
    if (frame.type !== "system") return [];
    const taskId = id(frame.task_id);
    if (!taskId) return [];
    const previous = this.tasks.get(taskId);
    const toolItemId = id(frame.tool_use_id) ?? previous?.toolItemId;
    const base: BackgroundTask = {
      id: taskId,
      kind: this.kind(frame, previous),
      description: text(frame.description, 500) ?? previous?.description ?? "Background task",
      state: previous?.state ?? "running",
      ...(previous?.summary ? { summary: previous.summary } : {}),
      ...(previous?.outputPath ? { outputPath: previous.outputPath } : {}),
      ...(toolItemId ? { toolItemId } : {}),
      startedAt: previous?.startedAt ?? this.now(),
      ...(previous?.endedAt ? { endedAt: previous.endedAt } : {}),
    };
    if (frame.subtype === "task_started") return this.update({ ...base, state: "running" });
    if (frame.subtype === "task_progress") {
      if (previous && previous.state !== "running") return [];
      const summary = text(frame.summary) ?? text(frame.last_tool_name, 200);
      return this.update({ ...base, ...(summary ? { summary } : {}) });
    }
    if (frame.subtype === "task_notification") {
      const state = states.find((value) => value === frame.status);
      if (!state) return [];
      const summary = text(frame.summary),
        outputPath = text(frame.output_file, 4096);
      return this.update({
        ...base,
        state,
        ...(summary ? { summary } : {}),
        ...(outputPath ? { outputPath } : {}),
        endedAt: this.now(),
      });
    }
    return [];
  }
  /** A Bash tool result for a command Claude moved to the background. */
  shell(toolUseId: string, input: Frame, content: unknown, result: unknown): AgentEvent[] {
    const structured =
      result && typeof result === "object" ? id((result as Frame).backgroundTaskId) : undefined;
    const body =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) =>
                block && typeof block === "object" && typeof (block as Frame).text === "string"
                  ? ((block as Frame).text as string)
                  : "",
              )
              .join("\n")
          : "";
    const taskId = structured ?? id(shellNotice.exec(body)?.[1]);
    if (!taskId) return [];
    const previous = this.tasks.get(taskId);
    if (previous && previous.state !== "running") return [];
    const outputPath = text(outputNotice.exec(body)?.[1], 4096);
    return this.update({
      id: taskId,
      kind: "shell",
      description: text(input.description, 500) ?? text(input.command, 500) ?? "Background command",
      state: "running",
      ...(outputPath ? { outputPath } : {}),
      toolItemId: toolUseId,
      startedAt: previous?.startedAt ?? this.now(),
    });
  }
  stopped(taskId: string): AgentEvent[] {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "running") return [];
    return this.update({ ...task, state: "stopped", endedAt: this.now() });
  }
  /** The native process ended, so every task it owned ended too. */
  ended(): AgentEvent[] {
    return this.running().flatMap((task) => this.stopped(task.id));
  }
}
