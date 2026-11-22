import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { NativeConnection } from "../../../../desktop/src/cloud-connections/manager.js";
import { desktopCloudSettings } from "./cloud-settings";

const sessionId = "6c64e34e-5168-4a81-8ef1-c4338ebb155c";
const member = "member";
const orgId = "personal";
const deviceId = "D".repeat(22);
const now = new Date("2026-01-14T13:00:00Z").toISOString();
const approval = {
  id: "mac-approval",
  agentId: "cloud-codex",
  threadId: "thread",
  turnId: "turn",
  taskId: "task",
  type: "approval",
  items: [{ id: "command", prompt: "Run on my Mac", choices: [{ id: "allow_once" }] }],
  chain: [],
  urgency: "blocking",
  version: 1,
  state: "pending",
  createdAt: now,
  context: {
    macExec: {
      v: 1,
      orgId,
      userId: member,
      requestId: "request",
      taskId: "task",
      turnId: "turn",
      targetDeviceId: deviceId,
      scope: "command",
      command: "uname",
      cwd: "/example/project",
      stdinHash: createHash("sha256").update("").digest("base64url"),
      timeoutSeconds: 60,
    },
  },
};
const fixtures = {
  project: [{ id: "cloud-project", name: "Example project" }],
  interaction: [approval],
};

it("keeps Cloud idle before opt-in and binds settings, credentials, and approvals to the selected account", async () => {
  const root = await mkdtemp(join(tmpdir(), "zoltbot-shell-cloud-settings-"));
  const preferences = join(root, "desktop", "mac-runner.json");
  let active: string | undefined = sessionId;
  let publish: Parameters<NativeConnection["subscribe"]>[0] | undefined;
  const cloudDevice = vi.fn(async () => ({ deviceId, publicKey: "A".repeat(43) }));
  const cloudRequest = vi.fn(
    async (_session: string, _path: string, _method?: string, _payload?: string) => ({
      ok: true,
    }),
  );
  const cloudSign = vi.fn<
    NonNullable<Parameters<typeof desktopCloudSettings>[0]["native"]>["cloudSign"]
  >(async (_sessionId, payload) => ({ payload, signature: "A".repeat(86) }));
  const native = {
    status: async () => (active ? { signedIn: true, sessionId: active } : { signedIn: false }),
    sessionId: () => active,
    cloudMacGithub: async () => "keychain:zoltbot:fixture-github",
    cloudDevice,
    cloudRequest,
    cloudSign,
  };
  const status = vi.fn(async () => ({
    configured: true,
    signedIn: true,
    managementUrl: "https://accounts.example.invalid/account",
    account: {
      user: { id: member },
      organizations: [{ id: orgId, kind: "personal", name: "Personal" }],
    },
  }));
  const call = vi.fn<NativeConnection["call"]>(async (method) => {
    if (method === "usage.get")
      return {
        periodStart: now,
        periodEnd: now,
        sandboxSeconds: 450,
        limitSeconds: 3600,
        tasks: [],
      };
    return { ok: true };
  });
  const endpoint: NativeConnection = {
    subscribe(listener) {
      publish = listener;
      return () => {
        publish = undefined;
      };
    },
    async start() {
      publish?.({ status: "online", snapshot: { seq: 1, entities: fixtures, counters: {} } });
    },
    stop() {},
    call,
  };
  const settings = desktopCloudSettings({
    native,
    account: { status },
    dataDir: root,
    local: endpoint,
    connect: () => endpoint,
    cellOrigin: "https://cell.example.invalid",
    pickFolder: async () => root,
  });
  try {
    await settings.restore();
    expect(status).not.toHaveBeenCalled();
    expect(cloudDevice).not.toHaveBeenCalled();
    expect(settings.workspace()).toBeUndefined();
    expect(await settings.status()).toMatchObject({ eligible: true, enabled: false });
    expect(cloudRequest.mock.calls.map(([, route]) => route)).toEqual(["/api/cloud/devices"]);

    expect(await settings.update({ type: "enabled", sessionId, value: true })).toMatchObject({
      enabled: true,
      runTasksOnMac: false,
      macExecution: "ask",
    });
    const owner = { kind: "cloud", sessionId, orgId } as const;
    expect(settings.workspace()?.owner).toEqual(owner);
    await settings.update({ type: "runner", sessionId, value: true });
    await settings.update({ type: "folder", sessionId, projectId: "cloud-project" });
    await settings.saveSecret({ sessionId, name: "anthropic", value: "synthetic-input-fixture" });
    expect(cloudRequest.mock.calls.map(([, route]) => route)).toContain(
      "/api/cloud/secrets/anthropic",
    );
    expect((await stat(preferences)).mode & 0o777).toBe(0o600);
    const policy = await readFile(preferences, "utf8");
    expect(policy.includes("synthetic-input-fixture")).toBe(false);
    expect(JSON.parse(policy)).toMatchObject({
      cloudEnabled: true,
      runTasksOnMac: true,
      folders: { "cloud-project": await realPath(root) },
    });
    await settings.answer({
      owner,
      id: approval.id,
      version: 1,
      action: "accept",
      choice: "allow_once",
    });
    expect(cloudSign).toHaveBeenCalledOnce();
    expect(cloudSign.mock.calls[0]?.[1]).toMatchObject({
      command: "uname",
      cwd: "/example/project",
      orgId,
      userId: member,
      signerDeviceId: deviceId,
    });
    expect(call).toHaveBeenCalledWith(
      "interaction.answer",
      expect.objectContaining({
        id: approval.id,
        answer: expect.objectContaining({
          signedApproval: expect.objectContaining({
            payload: expect.objectContaining({ command: "uname" }),
          }),
        }),
      }),
      expect.any(String),
    );
    publish?.({
      status: "online",
      snapshot: {
        seq: 2,
        counters: {},
        entities: {
          ...fixtures,
          interaction: [
            { ...approval, context: { ...approval.context, toolInput: { stdin: "changed" } } },
          ],
        },
      },
    });
    await expect(
      settings.answer({
        owner,
        id: approval.id,
        version: 1,
        action: "accept",
        choice: "allow_once",
      }),
    ).rejects.toThrow("cloud_interaction_changed");
    expect(cloudSign).toHaveBeenCalledOnce();
    publish?.({
      status: "online",
      snapshot: {
        seq: 3,
        counters: {},
        entities: {
          ...fixtures,
          interaction: [
            {
              ...approval,
              context: { macExec: { ...approval.context.macExec, targetDeviceId: "B".repeat(22) } },
            },
          ],
        },
      },
    });
    await expect(
      settings.answer({
        owner,
        id: approval.id,
        version: 1,
        action: "accept",
        choice: "allow_once",
      }),
    ).rejects.toThrow("cloud_interaction_changed");
    expect(cloudSign).toHaveBeenCalledOnce();
    active = undefined;
    settings.invalidate();
    expect(settings.workspace()).toBeUndefined();
    await expect(settings.update({ type: "runner", sessionId, value: false })).rejects.toThrow(
      "account_session_changed",
    );
  } finally {
    settings.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function realPath(path: string) {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
