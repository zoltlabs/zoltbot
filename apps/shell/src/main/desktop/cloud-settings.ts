import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CloudUsageSchema, InteractionSchema, methodCatalog, parse } from "@zoltbot/protocol";
import {
  type MacRunnerPreferences,
  macRunnerPreferencesSchema,
  readMacRunnerPreferences,
} from "../../../../../packages/daemon/src/cloud-runner/preferences.js";
import { cellConnection } from "../../../../desktop/src/cloud-connections/cell.js";
import { brokerCellCredentials } from "../../../../desktop/src/cloud-connections/credentials.js";
import {
  type CloudAccountBinding,
  connectionManager,
  type NativeConnection,
} from "../../../../desktop/src/cloud-connections/manager.js";
import type {
  CloudAnswer,
  CloudOwner,
  CloudSetting,
  CloudSettingsStatus,
  CloudWorkspace,
} from "../../shared/cloud";
import type { cloudAccount } from "./cloud-account";
import type { desktopAccountClient } from "./native-account-client";

const secretRoute = {
  github: "/api/cloud/secrets/github",
  anthropic: "/api/cloud/secrets/anthropic",
  openai: "/api/cloud/secrets/openai",
} as const;
const denied = new Set([
  "sign_in_required",
  "account_access_refused",
  "account_access_revoked",
  "account_session_changed",
]);
const blank = (configured: boolean): CloudSettingsStatus => ({
  configured,
  online: false,
  eligible: false,
  enabled: false,
  runTasksOnMac: false,
  macExecution: "ask",
  projects: [],
});

export function desktopCloudSettings(options: {
  account: Pick<ReturnType<typeof cloudAccount>, "status">;
  native?: Pick<
    ReturnType<typeof desktopAccountClient>,
    "cloudDevice" | "cloudMacGithub" | "cloudRequest" | "cloudSign" | "sessionId" | "status"
  >;
  connect?: typeof cellConnection;
  cellOrigin?: string;
  dataDir: string;
  local: NativeConnection;
  pickFolder(): Promise<string | undefined>;
}) {
  const { native, cellOrigin } = options;
  const file = join(options.dataDir, "desktop", "mac-runner.json");
  let selected: (CloudAccountBinding & { deviceId: string }) | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  let closed = false;
  let current = blank(!!(native && cellOrigin));
  const connections = connectionManager({
    local: () => options.local,
    cloud(account) {
      if (!native || !cellOrigin || selected?.sessionId !== account.sessionId)
        throw new Error("account_session_changed");
      return (options.connect ?? cellConnection)({
        origin: cellOrigin,
        account,
        deviceId: selected.deviceId,
        credentials: brokerCellCredentials(
          {
            sessionId: native.sessionId,
            cloudRequest: (route, method, payload, signal) =>
              native.cloudRequest(account.sessionId, route, method, payload, signal),
          },
          account,
          selected.deviceId,
        ),
      });
    },
  });

  function workspace(entry = connections.cloudState()): CloudWorkspace | undefined {
    return entry?.owner.kind === "cloud"
      ? {
          ...entry,
          owner: entry.owner,
          ...(selected?.sessionId === entry.owner.sessionId
            ? { approvalDeviceId: selected.deviceId }
            : {}),
        }
      : undefined;
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  }

  function invalidate() {
    generation++;
    selected = undefined;
    current = blank(current.configured);
    if (!closed) connections.setAccount();
  }

  async function refresh(probe: boolean) {
    const stamp = generation;
    if (!native || !cellOrigin || closed) return current;
    const stored = await readMacRunnerPreferences(file).catch((error: unknown) => {
      invalidate();
      throw error;
    });
    const saved = stored?.settings;
    if (!probe && !saved?.cloudEnabled) {
      if (connections.cloudState()) invalidate();
      return current;
    }
    try {
      const raw = await options.account.status();
      if (stamp !== generation || closed) return current;
      const sessionId = native.sessionId();
      if (!raw.signedIn || !sessionId) {
        invalidate();
        return current;
      }
      const profile = raw.account as {
        user?: { id?: unknown };
        organizations?: Array<{ id?: unknown; name?: unknown; kind?: unknown }>;
      };
      const org = profile.organizations?.find((item) => item.kind === "personal");
      if (
        typeof profile.user?.id !== "string" ||
        typeof org?.id !== "string" ||
        typeof org.name !== "string"
      )
        throw new Error("cloud_account_unavailable");
      if (selected && selected.sessionId !== sessionId) {
        selected = undefined;
        connections.setAccount();
      }
      const binding = { userId: profile.user.id, sessionId, orgId: org.id, name: org.name };
      const preferences =
        saved?.sessionId === sessionId && saved.orgId === binding.orgId ? saved : undefined;
      const base: CloudSettingsStatus = {
        ...blank(true),
        online: true,
        account: { userId: binding.userId, orgId: binding.orgId, sessionId, orgName: binding.name },
        enabled: preferences?.cloudEnabled === true,
        runTasksOnMac: preferences?.runTasksOnMac ?? false,
        macExecution: preferences?.macExecution ?? "ask",
      };
      current = base;
      if (!base.enabled) connections.setAccount();
      if (!probe && !base.enabled) return current;
      let deviceId = base.enabled && !connections.cloudState() ? undefined : selected?.deviceId;
      if (!deviceId) {
        const key = await native.cloudDevice(sessionId);
        if (stamp !== generation || native.sessionId() !== sessionId || closed) return current;
        await native.cloudRequest(sessionId, "/api/cloud/devices", "POST", JSON.stringify(key));
        deviceId = key.deviceId;
      }
      if (stamp !== generation || native.sessionId() !== sessionId || closed) return current;
      selected = { ...binding, deviceId };
      current = { ...base, eligible: true };
      if (base.enabled) connections.setAccount(binding);
      const currentWorkspace = workspace();
      const projects = (currentWorkspace?.state.snapshot.entities.project ?? []).flatMap(
        (project) =>
          typeof project.id === "string" && typeof project.name === "string"
            ? [
                {
                  id: project.id,
                  name: project.name,
                  ...(preferences?.folders[project.id]
                    ? { folder: preferences.folders[project.id] }
                    : {}),
                },
              ]
            : [],
      );
      let usage: CloudSettingsStatus["usage"];
      if (currentWorkspace && !currentWorkspace.readOnly) {
        try {
          usage = parse(
            CloudUsageSchema,
            await connections.call(currentWorkspace.owner, "usage.get", {}),
          );
        } catch {
          // A stale usage result never changes the account or enables edits.
        }
      }
      if (stamp !== generation || native.sessionId() !== sessionId || closed) return current;
      current = { ...current, projects, ...(usage ? { usage } : {}) };
    } catch (error) {
      const explicitlyDenied = error instanceof Error && denied.has(error.message);
      if (stamp !== generation || closed) return current;
      if (explicitlyDenied) {
        selected = undefined;
        connections.setAccount();
      }
      current = { ...current, online: explicitlyDenied, eligible: false };
    }
    return current;
  }

  async function requireAccount(sessionId: string) {
    if (
      closed ||
      !native ||
      !selected ||
      !current.eligible ||
      !current.online ||
      selected.sessionId !== sessionId ||
      (await native.status()).sessionId !== sessionId ||
      selected?.sessionId !== sessionId
    )
      throw new Error("account_session_changed");
    return selected;
  }

  async function write(settings: MacRunnerPreferences) {
    const value = parse(macRunnerPreferencesSchema, settings);
    const folder = dirname(file);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("cloud_settings_unavailable");
    const temporary = join(folder, `mac-runner-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    workspace,
    subscribe: (listener: (state: CloudWorkspace | undefined) => void) =>
      connections.subscribeCloud((entry) => listener(workspace(entry))),
    call: (owner: CloudOwner, method: string, params: unknown, commandId?: string) =>
      connections.call(owner, method, params, commandId),
    answer(input: CloudAnswer) {
      return serial(async () => {
        const view = workspace();
        const account = await requireAccount(input.owner.sessionId);
        if (
          !native ||
          !view ||
          view.readOnly ||
          view.owner.orgId !== input.owner.orgId ||
          view.owner.sessionId !== input.owner.sessionId
        )
          throw new Error("cloud_offline");
        const request = parse(
          InteractionSchema,
          view.state.snapshot.entities.interaction?.find((row) => row.id === input.id),
        );
        if (request.version !== input.version || request.state !== "pending")
          throw new Error("cloud_interaction_changed");
        const draft = request.context?.macExec;
        const now = Date.now();
        let signedApproval: Awaited<ReturnType<typeof native.cloudSign>> | undefined;
        if (draft && input.action === "accept") {
          const shown = request.context?.toolInput as
            | { stdin?: unknown; timeoutSeconds?: unknown }
            | undefined;
          const stdin = shown?.stdin ?? "";
          if (
            draft.orgId !== account.orgId ||
            draft.userId !== account.userId ||
            draft.scope !== "command" ||
            draft.targetDeviceId !== account.deviceId ||
            typeof stdin !== "string" ||
            createHash("sha256").update(stdin).digest("base64url") !== draft.stdinHash ||
            (shown?.timeoutSeconds !== undefined &&
              shown.timeoutSeconds !== draft.timeoutSeconds) ||
            (stdin && input.choice === "allow_task_prefix")
          )
            throw new Error("cloud_interaction_changed");
          const prefix = request.items
            .flatMap((item) => item.choices ?? [])
            .find((choice) => choice.id === "allow_task_prefix");
          if (
            input.choice !== "allow_once" &&
            (input.choice !== "allow_task_prefix" || !prefix || prefix.id !== "allow_task_prefix")
          )
            throw new Error("approval_invalid");
          signedApproval = await native.cloudSign(input.owner.sessionId, {
            ...draft,
            ...(input.choice === "allow_task_prefix" && prefix?.id === "allow_task_prefix"
              ? { scope: "prefix", command: prefix.prefix }
              : {}),
            signerDeviceId: account.deviceId,
            issuedAt: now,
            expiresAt: now + 300_000,
          });
        }
        const params = parse(methodCatalog["interaction.answer"].params, {
          id: input.id,
          version: input.version,
          answer: {
            action: input.action,
            by: { kind: "human", id: account.userId },
            at: new Date(now).toISOString(),
            ...(input.answers ? { answers: input.answers } : {}),
            ...(input.choice ? { choice: input.choice } : {}),
            ...(signedApproval ? { signedApproval } : {}),
          },
        });
        return connections.call(input.owner, "interaction.answer", params, randomUUID());
      });
    },
    restore: () => serial(() => refresh(false)),
    status: () => serial(() => refresh(true)),
    invalidate,
    update(setting: CloudSetting) {
      return serial(async () => {
        const account = await requireAccount(setting.sessionId);
        const saved = (await readMacRunnerPreferences(file))?.settings;
        const preferences: MacRunnerPreferences =
          saved?.sessionId === setting.sessionId && saved.orgId === account.orgId
            ? saved
            : {
                version: 1,
                sessionId: setting.sessionId,
                orgId: account.orgId,
                macExecution: "ask",
                runTasksOnMac: false,
                folders: {},
              };
        if (setting.type === "enabled") {
          preferences.cloudEnabled = setting.value;
        } else {
          if (!preferences.cloudEnabled) throw new Error("cloud_settings_unavailable");
          switch (setting.type) {
            case "runner":
              preferences.runTasksOnMac = setting.value;
              break;
            case "execution":
              preferences.macExecution = setting.value;
              break;
            case "folder": {
              const project = () =>
                workspace()?.state.snapshot.entities.project?.some(
                  (entry) => entry.id === setting.projectId,
                );
              if (!project()) throw new Error("cloud_project_unavailable");
              const folder = await options.pickFolder();
              if (!folder) return current;
              const resolved = await realpath(folder);
              if (!(await lstat(resolved)).isDirectory() || !project())
                throw new Error("cloud_project_unavailable");
              preferences.folders = { ...preferences.folders, [setting.projectId]: resolved };
              break;
            }
          }
        }
        await requireAccount(setting.sessionId);
        await write(preferences);
        if (!preferences.cloudEnabled) connections.setAccount();
        return refresh(true);
      });
    },
    saveSecret(input: {
      sessionId: string;
      name: "anthropic" | "openai" | "github";
      value: string;
    }) {
      return serial(async () => {
        const account = await requireAccount(input.sessionId);
        if (
          !current.enabled ||
          !native ||
          !["anthropic", "openai", "github"].includes(input.name) ||
          !input.value.trim() ||
          Buffer.byteLength(input.value) > (input.name === "github" ? 8192 : 65536) ||
          /[\0\r\n]/.test(input.value)
        )
          throw new Error("cloud_secret_invalid");
        await native.cloudRequest(
          input.sessionId,
          secretRoute[input.name],
          "PUT",
          JSON.stringify({ value: input.value }),
        );
        if (input.name === "github") {
          const preferences = (await readMacRunnerPreferences(file))?.settings;
          if (
            !preferences ||
            preferences.orgId !== account.orgId ||
            preferences.sessionId !== input.sessionId
          )
            throw new Error("account_session_changed");
          await requireAccount(input.sessionId);
          const reference = await native.cloudMacGithub(
            input.sessionId,
            input.value,
            preferences.keys?.github,
          );
          await requireAccount(input.sessionId);
          await write({ ...preferences, keys: { ...preferences.keys, github: reference } });
        }
      });
    },
    close() {
      closed = true;
      invalidate();
      connections.close();
    },
  };
}
