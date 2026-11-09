import { createHash, randomUUID } from "node:crypto";

import path from "node:path";
import type { DomainState } from "@zoltbot/core/projectors";
import { compareSessions, type TerminalInfo, type TerminalOutput } from "@zoltbot/protocol";
import { type IPty, spawn } from "node-pty";
import { canonicalApprovalRoot } from "./approval-paths.js";
import { TerminalOutputBuffer } from "./terminal-output.js";
import { terminalProcessGroups } from "./terminal-process.js";

const MAX_TERMINALS = 32;
const MAX_ATTACHMENTS = 64;
const DETACHED_TTL = 24 * 60 * 60 * 1000;
interface Terminal {
  info: TerminalInfo;
  owner: string;
  rootKey: string;
  inputBudget: number;
  inputAt: number;
  pty: IPty;
  output: TerminalOutputBuffer;
  touched: number;
  wake: Set<() => void>;
  receipts: Map<string, string>;
  stopping?: ReturnType<typeof setTimeout>;
}
interface Attachment {
  terminal: string;
  client: object;
  /** Attached to view a terminal another device owns (D-6): reads only, never input. */
  readOnly: boolean;
  pending: boolean;
  touched: number;
}
/** Human-operated shells, separate from adapter/native execution. No output enters domain logs. */
export class TerminalRuntime {
  private terminals = new Map<string, Terminal>();
  private attachments = new Map<string, Attachment>();
  private creates = new Map<string, { fingerprint: string; id: string }>();
  private closed = false;
  private timer = setInterval(() => this.sweep(), 60_000);
  constructor(
    private snapshot: () => DomainState,
    private spawnPty = spawn,
  ) {
    this.timer.unref();
  }
  private workspace(threadId: string) {
    const state = this.snapshot();
    const thread = state.thread?.find((r) => r.id === threadId && !r.archived);
    const profile = state.agent?.find((r) => r.id === thread?.agentId && !r.archived);
    if (!thread || !profile) throw Error("terminal_thread_unavailable");
    const task = state.task?.find((row) => row.id === thread.taskId);
    const fork = thread.fork as { permissionCeiling?: string } | undefined;
    if (
      (thread.projectId &&
        !state.project?.some((row) => row.id === thread.projectId && !row.archived)) ||
      (thread.taskId && !task)
    )
      throw Error("terminal_workspace_changed");
    if (
      profile.permissionProfile === "read_only" ||
      task?.permissionCeiling === "read_only" ||
      fork?.permissionCeiling === "read_only" ||
      state.compareMember?.some((r) => r.threadId === threadId && r.ceiling === "read_only") ||
      state.compare?.some((r) => r.summaryThreadId === threadId)
    )
      throw Error("terminal_permission_denied");
    const session = state.session?.filter((r) => r.threadId === threadId).sort(compareSessions)[0];
    if (!session || typeof session.cwd !== "string" || !path.isAbsolute(session.cwd))
      throw Error("terminal_workspace_not_ready");
    if (
      session.workspaceId &&
      !state.workspace?.some(
        (row) =>
          row.id === session.workspaceId &&
          row.state === "active" &&
          row.path === session.cwd &&
          row.projectId === thread.projectId,
      )
    )
      throw Error("terminal_workspace_changed");
    const root = canonicalApprovalRoot(session.cwd);
    if (!root || root.path !== session.cwd) throw Error("terminal_workspace_changed");
    return {
      sessionId: String(session.id),
      cwd: root.path,
      rootKey: `${root.device}:${root.inode}`,
    };
  }
  /** The terminal, if `owner` owns it; with no owner, any terminal in the chat (for viewing). */
  private require(owner: string | undefined, threadId: string, id: string, validate = true) {
    if (this.closed) throw Error("terminal_runtime_closed");
    const terminal = this.terminals.get(id);
    if (
      !terminal ||
      (owner !== undefined && terminal.owner !== owner) ||
      terminal.info.threadId !== threadId
    )
      throw Error("terminal_unavailable");
    const workspace = validate
      ? this.workspace(threadId)
      : { ...terminal.info, rootKey: terminal.rootKey };
    if (
      workspace.sessionId !== terminal.info.sessionId ||
      workspace.cwd !== terminal.info.cwd ||
      workspace.rootKey !== terminal.rootKey
    )
      throw Error("terminal_workspace_changed");
    return terminal;
  }
  async api(
    method: string,
    params: Record<string, unknown>,
    commandId: string | undefined,
    owner: string,
    client: object,
  ) {
    if (!method.startsWith("terminal.")) return undefined;
    if (this.closed) throw Error("terminal_runtime_closed");
    const threadId = String(params.threadId);
    if (method === "terminal.create") {
      if (!commandId || params.confirmed !== true) throw Error("terminal_confirmation_required");
      const workspace = this.workspace(threadId);
      const fingerprint = JSON.stringify([threadId, workspace, params.cols, params.rows]);
      const key = `${owner}:${commandId}`;
      const previous = this.creates.get(key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw Error("terminal_command_conflict");
        return { ...this.require(owner, threadId, previous.id).info };
      }
      if (this.terminals.size >= MAX_TERMINALS) {
        const inactive = [...this.terminals.values()]
          .filter(
            (t) =>
              t.info.status === "exited" &&
              !t.stopping &&
              ![...this.attachments.values()].some((a) => a.terminal === t.info.id),
          )
          .sort((a, b) => a.touched - b.touched)[0];
        if (inactive) this.terminals.delete(inactive.info.id);
      }
      if (
        this.creates.size >= 4096 ||
        this.terminals.size >= MAX_TERMINALS ||
        [...this.terminals.values()].filter(
          (t) => t.owner === owner && t.info.threadId === threadId && t.info.status !== "exited",
        ).length >= 4
      )
        throw Error("terminal_limit");
      const cols = Number(params.cols),
        rows = Number(params.rows);
      const env: Record<string, string> = {};
      // Deliberately omit daemon/provider credentials, NODE_OPTIONS and multiplexer state.
      for (const name of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR", "SHELL"])
        if (process.env[name]) env[name] = process.env[name];
      env.TERM = "xterm-256color";
      let pty: IPty;
      try {
        pty = this.spawnPty(process.env.SHELL || "/bin/sh", ["-l"], {
          cwd: workspace.cwd,
          cols,
          rows,
          name: "xterm-256color",
          env,
        });
      } catch {
        throw Error("terminal_spawn_failed");
      }
      const id = randomUUID();
      const terminal: Terminal = {
        info: {
          id,
          threadId,
          sessionId: workspace.sessionId,
          cwd: workspace.cwd,
          cols,
          rows,
          status: "running",
        },
        owner,
        rootKey: workspace.rootKey,
        inputBudget: 65536,
        inputAt: Date.now(),
        pty,
        output: new TerminalOutputBuffer(),
        touched: Date.now(),
        wake: new Set(),
        receipts: new Map(),
      };
      this.terminals.set(id, terminal);
      this.creates.set(key, { fingerprint, id });
      pty.onData((data) => {
        terminal.output.append(data);
        for (const wake of terminal.wake) wake();
      });
      pty.onExit(({ exitCode, signal }) => {
        terminal.info.status = "exited";
        terminal.info.exitCode = exitCode;
        if (signal !== undefined) terminal.info.signal = signal;
        for (const wake of terminal.wake) wake();
      });
      return { ...terminal.info };
    }
    if (method === "terminal.list") {
      const workspace = this.workspace(threadId);
      return {
        items: [...this.terminals.values()]
          .filter(
            (t) =>
              (params.readOnly === true || t.owner === owner) &&
              t.info.threadId === threadId &&
              t.info.sessionId === workspace.sessionId &&
              t.info.cwd === workspace.cwd,
          )
          .map((t) => ({ ...t.info })),
      };
    }
    const viewing =
      method === "terminal.attach"
        ? params.readOnly === true
        : ["terminal.read", "terminal.detach"].includes(method) &&
          this.attachments.get(String(params.attachmentId))?.readOnly === true;
    const terminal = this.require(
      viewing ? undefined : owner,
      threadId,
      String(params.id),
      !["terminal.close", "terminal.detach"].includes(method),
    );
    terminal.touched = Date.now();
    if (method === "terminal.attach") {
      if (this.attachments.size >= MAX_ATTACHMENTS) throw Error("terminal_attachment_limit");
      const attachmentId = randomUUID();
      this.attachments.set(attachmentId, {
        terminal: terminal.info.id,
        client,
        readOnly: viewing,
        pending: false,
        touched: Date.now(),
      });
      return { attachmentId };
    }
    if (method === "terminal.read" || method === "terminal.detach") {
      const attachmentId = String(params.attachmentId),
        attachment = this.attachments.get(attachmentId);
      if (!attachment || attachment.client !== client || attachment.terminal !== terminal.info.id)
        throw Error("terminal_attachment_unavailable");
      attachment.touched = Date.now();
      if (method === "terminal.detach") {
        this.attachments.delete(attachmentId);
        for (const wake of terminal.wake) wake();
        return { ok: true };
      }
      if (attachment.pending) throw Error("terminal_read_pending");
      const offset = Number(params.offset);
      if (offset > terminal.output.offset) throw Error("terminal_invalid_offset");
      attachment.pending = true;
      try {
        if (offset === terminal.output.offset && terminal.info.status !== "exited")
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              terminal.wake.delete(finish);
              resolve();
            };
            const timer = setTimeout(finish, 15_000);
            terminal.wake.add(finish);
          });
        if (!this.attachments.has(attachmentId)) throw Error("terminal_attachment_unavailable");
        this.require(viewing ? undefined : owner, threadId, terminal.info.id);
        return {
          terminal: { ...terminal.info },
          ...terminal.output.read(offset),
        } satisfies TerminalOutput;
      } finally {
        attachment.pending = false;
      }
    }
    if (!commandId) throw Error("command_id_required");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([method, params]))
      .digest("hex");
    const previous = terminal.receipts.get(commandId);
    if (previous) {
      if (previous !== fingerprint) throw Error("terminal_command_conflict");
      return { ok: true };
    }
    if (method !== "terminal.close" && terminal.receipts.size >= 8192)
      throw Error("terminal_command_limit");
    if (method === "terminal.close") this.stop(terminal);
    else {
      if (terminal.info.status !== "running") throw Error("terminal_not_running");
      if (method === "terminal.input") {
        const data = String(params.data),
          now = Date.now();
        terminal.inputBudget = Math.min(
          65536,
          terminal.inputBudget + (now - terminal.inputAt) * 65.536,
        );
        terminal.inputAt = now;
        if (Buffer.byteLength(data) > terminal.inputBudget)
          throw Error("terminal_input_backpressure");
        terminal.inputBudget -= Buffer.byteLength(data);
        terminal.pty.write(data);
      } else if (method === "terminal.resize") {
        terminal.pty.resize(Number(params.cols), Number(params.rows));
        terminal.info.cols = Number(params.cols);
        terminal.info.rows = Number(params.rows);
      } else throw Error("terminal_method_unavailable");
    }
    if (terminal.receipts.size < 8192) terminal.receipts.set(commandId, fingerprint);
    return { ok: true };
  }
  detach(client: object) {
    for (const [id, attachment] of this.attachments)
      if (attachment.client === client) this.attachments.delete(id);
    for (const terminal of this.terminals.values()) for (const wake of terminal.wake) wake();
  }
  private stop(terminal: Terminal) {
    if (terminal.info.status !== "running") return;
    terminal.info.status = "stopping";
    const signalGroups = terminalProcessGroups(terminal.pty.pid);
    if (!signalGroups("SIGTERM")) {
      try {
        terminal.pty.kill("SIGTERM");
      } catch {}
    }
    terminal.stopping = setTimeout(() => {
      signalGroups("SIGKILL");
      delete terminal.stopping;
    }, 1000);
    terminal.stopping.unref();
  }
  private sweep() {
    for (const [id, attachment] of this.attachments)
      if (Date.now() - attachment.touched > 60_000) this.attachments.delete(id);
    for (const [id, terminal] of this.terminals) {
      try {
        this.require(terminal.owner, terminal.info.threadId, id);
      } catch {
        this.stop(terminal);
      }
      const attached = [...this.attachments.values()].some((a) => a.terminal === id);
      if (!attached && Date.now() - terminal.touched > DETACHED_TTL) {
        this.stop(terminal);
        if (terminal.info.status === "exited") this.terminals.delete(id);
      }
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.attachments.clear();
    for (const terminal of this.terminals.values()) {
      this.stop(terminal);
      for (const wake of terminal.wake) wake();
    }
    if ([...this.terminals.values()].some((t) => t.stopping !== undefined))
      await new Promise((resolve) => setTimeout(resolve, 1100));
    for (const terminal of this.terminals.values()) clearTimeout(terminal.stopping);
    this.terminals.clear();
    this.creates.clear();
  }
}
