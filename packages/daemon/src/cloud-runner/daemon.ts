import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { claudeDefinitions } from "@zoltbot/adapters-claude/definitions";
import { codexDefinitions } from "@zoltbot/adapters-codex/definitions";
import { CellTokenResultSchema } from "@zoltbot/cloud-contracts";
import { discoverBinaries, knownDirectories, LoginPath } from "@zoltbot/detect";
import { type Identity, linkId } from "@zoltbot/link";
import { methodCatalog, parse, TaskSchema, TurnSchema } from "@zoltbot/protocol";
import type { RunnerHello } from "@zoltbot/runner-protocol";
import { accountBrokerClient } from "../account-session/broker-client.js";
import { brokerRunnerRequest } from "../account-session/runner.js";
import type { PrivateVault } from "../private-context.js";
import { isSecretReference } from "../secrets.js";
import { RunnerAccessRevokedError } from "./connection.js";
import { type MacRunnerOptions, startMacRunner } from "./mac.js";
import {
  type MacRunnerPreferences as Preferences,
  readMacRunnerPreferences,
} from "./preferences.js";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$" });
const member = Type.Object({
  sessionId: Type.String(),
  user: Type.Object({ id }),
  organizations: Type.Array(Type.Object({ id, kind: Type.Optional(Type.String()) })),
});
type NativeAccount = ReturnType<typeof accountBrokerClient>;
type StartRunner = (options: MacRunnerOptions) => { close(): Promise<void> };

export interface DaemonMacRunnerOptions {
  dataDir: string;
  origin: string;
  socketPath: string;
  vault: PrivateVault;
  identity(): Promise<Identity>;
  status(code: string): void;
  fetch?: typeof fetch;
  discover?(directory: string): Promise<RunnerHello["clis"]>;
  start?: StartRunner;
}

async function discoverMacClis(directory: string): Promise<RunnerHello["clis"]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const home = homedir();
  const paths = await new LoginPath().resolve(process.env.SHELL ?? "/bin/zsh", {
    cwd: directory,
    inherited: { HOME: home, PATH: process.env.PATH },
  });
  const known = await knownDirectories(home);
  const clis: RunnerHello["clis"] = [];
  for (const agent of [...claudeDefinitions, ...codexDefinitions]) {
    const found = await discoverBinaries({
      binaryNames: agent.binaryNames,
      versionCommand: agent.versionCommand,
      testedVersions: agent.testedVersions,
      cwd: directory,
      path: paths,
      knownDirectories: known,
      inherited: { HOME: home, PATH: paths.join(path.delimiter) },
    });
    if (found.selected?.version) clis.push({ id: agent.adapter, version: found.selected.version });
  }
  return clis;
}

async function localKey(
  vault: PrivateVault,
  config: Preferences,
  name: "github" | "anthropic" | "openai",
  signal: AbortSignal,
) {
  const reference = config.keys?.[name];
  if (!reference) return undefined;
  if (signal.aborted || !isSecretReference(reference)) throw new Error("runner_key_unavailable");
  const current = (await vault.read(reference)) as {
    version?: unknown;
    sessionId?: unknown;
    keyName?: unknown;
    value?: unknown;
  } | null;
  if (
    signal.aborted ||
    current?.version !== 1 ||
    current.sessionId !== config.sessionId ||
    current.keyName !== name ||
    typeof current.value !== "string" ||
    !current.value ||
    current.value.length > 8192 ||
    /[\0\r\n]/.test(current.value)
  )
    throw new Error("runner_key_unavailable");
  return current.value;
}

function macTask(
  options: DaemonMacRunnerOptions,
  client: NativeAccount,
  settings: Preferences,
  userId: string,
  deviceId: string,
): NonNullable<MacRunnerOptions["macExecution"]>["task"] {
  return async (taskId, turnId, signal) => {
    const request = JSON.stringify({ orgId: settings.orgId, deviceId });
    const access = parse(
      CellTokenResultSchema,
      await client.cloudRequest("/api/cloud/cell-token", "POST", request, signal),
    );
    const origin = new URL(access.cellUrl);
    if (origin.protocol !== "https:" || origin.origin !== access.cellUrl || signal.aborted)
      throw new Error("mac_unavailable");
    const response = await (options.fetch ?? fetch)(
      new URL(`/v1/orgs/${encodeURIComponent(settings.orgId)}/rpc`, origin),
      {
        method: "POST",
        headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "snapshot.get", params: {} }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      },
    );
    if (!response.ok || !response.body) throw new Error("mac_unavailable");
    const reader = response.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error("mac_unavailable");
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const envelope = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (envelope?.jsonrpc !== "2.0" || envelope.id !== 1 || signal.aborted)
      throw new Error("mac_unavailable");
    const snapshot = parse(methodCatalog["snapshot.get"].result, envelope.result);
    const find = (name: string, value: string) =>
      snapshot.entities[name]?.find(
        (row) => row && typeof row === "object" && "id" in row && row.id === value,
      );
    const task = parse(TaskSchema, find("task", taskId)),
      turn = parse(TurnSchema, find("turn", turnId));
    if (
      !task.projectId ||
      !task.location ||
      task.createdBy.id !== userId ||
      turn.threadId !== task.threadId ||
      turn.status !== "running" ||
      !["queued", "running", "blocked"].includes(task.state)
    )
      return { active: false, folder: "" };
    const folder = Object.hasOwn(settings.folders, task.projectId)
      ? settings.folders[task.projectId]
      : undefined;
    if (folder) return { active: true, folder };
    const scratch = path.join(homedir(), "Zoltbot Scratch");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    return { active: !signal.aborted, folder: scratch };
  };
}

/** The real daemon owns opt-in, account fencing and shutdown. A saved grant is never recreated on boot. */
export function daemonMacRunner(options: DaemonMacRunnerOptions) {
  const file = path.join(options.dataDir, "desktop", "mac-runner.json");
  const root = path.join(options.dataDir, "cloud", "mac");
  const startup = options.start ?? startMacRunner;
  let stamp: string | undefined;
  let selected: Preferences | undefined;
  let runner: ReturnType<StartRunner> | undefined;
  let controller: AbortController | undefined;
  let pending: Promise<void> | undefined;
  let stopping = Promise.resolve();
  let closed = false;
  const stop = () => {
    controller?.abort();
    controller = undefined;
    const previous = runner;
    runner = undefined;
    if (previous)
      stopping = stopping
        .then(() => previous.close())
        .catch(() => options.status("runner_cleanup_required"));
    return stopping;
  };
  const refresh = async () => {
    try {
      const next = await readMacRunnerPreferences(file);
      if (closed || next?.stamp === stamp) return;
      stamp = next?.stamp;
      selected = undefined;
      await stop();
      if (
        closed ||
        !next ||
        next.settings.cloudEnabled === false ||
        (!next.settings.runTasksOnMac && next.settings.macExecution === "off")
      )
        return;
      const settings = next.settings;
      selected = settings;
      const attempt = new AbortController();
      controller = attempt;
      const client = accountBrokerClient({
        origin: options.origin,
        socketPath: options.socketPath,
        expectedSessionId: settings.sessionId,
      });
      try {
        await client.status();
      } catch (error) {
        if (error instanceof Error && error.message === "account_session_changed")
          throw new RunnerAccessRevokedError();
        throw error;
      }
      const identity = parse(member, await client.request("/me"));
      if (
        identity.sessionId !== settings.sessionId ||
        !identity.organizations.some((org) => org.id === settings.orgId && org.kind === "personal")
      )
        throw new RunnerAccessRevokedError();
      if (attempt.signal.aborted) return;
      const directory = path.join(
        root,
        createHash("sha256")
          .update(JSON.stringify([options.origin, identity.user.id, settings.orgId]))
          .digest("hex"),
      );
      const deviceId = linkId((await options.identity()).publicKey);
      const clis = settings.runTasksOnMac
        ? await (options.discover ?? discoverMacClis)(path.join(directory, "discovery"))
        : [];
      const current = await readMacRunnerPreferences(file);
      if (closed || attempt.signal.aborted || current?.stamp !== stamp) return;
      const canMacExec = settings.macExecution !== "off";
      runner = startup({
        directory,
        memberId: identity.user.id,
        account: {
          origin: options.origin,
          orgId: settings.orgId,
          deviceId,
          nativeRequest: brokerRunnerRequest(client),
        },
        capabilities: { canRunTasks: settings.runTasksOnMac, canMacExec },
        versions: { node: process.versions.node },
        clis,
        guard() {
          if (attempt.signal.aborted) throw new RunnerAccessRevokedError();
        },
        vault: async () => options.vault,
        providerKey: (provider, _taskId, signal) =>
          localKey(options.vault, settings, provider === "claude" ? "anthropic" : "openai", signal),
        githubToken: (signal) => localKey(options.vault, settings, "github", signal),
        tools: async () => ({
          definitions: [],
          tools: new Map(),
          authorize: () => false,
          checkLimits: () => false,
          async audit() {},
        }),
        ...(canMacExec
          ? {
              macExecution: {
                mac: hostname(),
                mode: () => (attempt.signal.aborted ? "off" : settings.macExecution),
                task: macTask(options, client, settings, identity.user.id, deviceId),
                environment: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" },
              },
            }
          : {}),
        status: options.status,
      });
    } catch (error) {
      await stop();
      const revoked = error instanceof RunnerAccessRevokedError;
      if (!revoked) stamp = undefined;
      if (!closed) options.status(revoked ? "runner_access_revoked" : "cloud_runner_unavailable");
    }
  };
  const schedule = () => {
    if (!closed && !pending)
      pending = refresh().finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(schedule, 2500);
  timer.unref();
  schedule();
  return {
    sessionChanged(sessionId: string | undefined) {
      if (selected && selected.sessionId !== sessionId) {
        selected = undefined;
        void stop();
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await stop();
      await pending;
      await stop();
    },
  };
}
