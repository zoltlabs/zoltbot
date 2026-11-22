import { approvalStdinHash, createIdentity, linkId, toB64 } from "@zoltbot/link";
import type { Interaction } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { OutcomeUnknownError } from "../data/transport.js";
import type { PhoneAccountStatus, PhoneCellConnection } from "./account.js";
import type { PhoneCloudState } from "./connection.js";
import { phoneCloudSession } from "./session.js";

const blank = { seq: 0, entities: {}, counters: {} };
const request: Interaction = {
  id: "request",
  type: "question",
  state: "pending",
  version: 1,
  createdAt: "2026-11-20T12:00:00Z",
  urgency: "blocking",
  chain: [],
  agentId: "agent",
  threadId: "thread",
  taskId: "task",
  items: [{ id: "question", prompt: "Which color?" }],
};
const draft = { action: "accept", answers: { question: { other: "blue" } } } as const;
const signedOut: PhoneAccountStatus = { configured: true, signedIn: false, online: true };

function signedIn(sessionId = "session", orgId = "personal"): PhoneAccountStatus {
  return {
    configured: true,
    signedIn: true,
    sessionId,
    online: true,
    account: {
      user: { id: "member", name: "Example Member", email: "member@example.invalid" },
      sessionId,
      organizations: [
        { id: "team", name: "Example Team", kind: "team", role: "owner" },
        { id: orgId, name: "Personal", kind: "personal", role: "owner" },
      ],
    },
  };
}

function fixture(initial = signedIn()) {
  const device = createIdentity();
  let status = initial;
  const observers = new Set<() => void>();
  const change = (next: PhoneAccountStatus) => {
    status = next;
    for (const observer of observers) observer();
  };
  const account = {
    status: vi.fn(async () => status),
    sessionId: () => status.sessionId,
    subscribe(observer: () => void) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    registerDevice: vi.fn(async (_session: string, _key: unknown) => {}),
    async signIn() {
      const next = signedIn();
      change(next);
      return next;
    },
    cancelSignIn: vi.fn(),
    async signOut(id: string) {
      if (status.sessionId !== id) throw new Error("account_session_changed");
      change(signedOut);
    },
  };
  let onCell: ((cell: PhoneCloudState) => void) | undefined;
  let cell: PhoneCloudState = { status: "connecting", readOnly: true, snapshot: blank };
  const show = (next: PhoneCloudState) => {
    cell = next;
    onCell?.(next);
  };
  const call = vi.fn(
    async (_method: string, _params: unknown, _id?: string): Promise<unknown> => ({}),
  );
  const stop = vi.fn();
  const start = vi.fn();
  const connection = vi.fn((owner: PhoneCellConnection["owner"]) => ({
    owner,
    state: () => cell,
    start,
    stop,
    call,
    subscribe(listener: (state: PhoneCloudState) => void) {
      onCell = listener;
      listener(cell);
      return () => {
        if (onCell === listener) onCell = undefined;
      };
    },
  }));
  const identity = vi.fn(async () => device);
  const manager = phoneCloudSession({
    configured: true,
    account,
    connection,
    identity,
    publish: () => {},
  });
  const online = (interaction = request) =>
    show({
      status: "online",
      readOnly: false,
      snapshot: { seq: 1, entities: { interaction: [interaction] }, counters: {} },
    });
  return {
    manager,
    account,
    connection,
    device,
    identity,
    call,
    change,
    stop,
    start,
    show,
    online,
  };
}

it("registers the phone key for the personal org after native sign-in", async () => {
  const f = fixture(signedOut);
  const cleanup = f.manager.start();
  await f.manager.refresh();
  expect(f.connection).not.toHaveBeenCalled();
  await f.manager.signIn();
  expect(f.account.registerDevice).toHaveBeenCalledExactlyOnceWith("session", {
    deviceId: linkId(f.device.publicKey),
    publicKey: toB64(f.device.publicKey),
  });
  expect(f.connection).toHaveBeenCalledExactlyOnceWith({
    userId: "member",
    sessionId: "session",
    orgId: "personal",
    deviceId: linkId(f.device.publicKey),
  });
  expect(f.start).toHaveBeenCalledOnce();
  cleanup();
});

it("clears the Cloud view on session loss and refuses an earlier account's push", async () => {
  const f = fixture();
  const cleanup = f.manager.start();
  await f.manager.refresh();
  f.online();
  const oldOwner = f.manager.state().owner;
  if (!oldOwner) throw new Error("missing_owner");
  const notice = {
    kind: "open_cloud" as const,
    orgId: "personal",
    notificationId: "notice",
    threadId: "thread",
  };
  await expect(f.manager.noticeTarget(notice)).resolves.toEqual({
    orgId: "personal",
    threadId: "thread",
  });
  await expect(f.manager.noticeTarget({ ...notice, orgId: "team" })).resolves.toBeUndefined();
  f.show({ status: "offline", readOnly: true, snapshot: blank, error: "cloud_authority_refused" });
  await expect(f.manager.noticeTarget(notice)).resolves.toBeUndefined();
  f.change(signedOut);
  expect(f.manager.state().cell).toBeUndefined();
  expect(f.stop).toHaveBeenCalledOnce();
  await expect(f.manager.answer(oldOwner, request, draft)).rejects.toThrow("cloud_offline");
  await expect(f.manager.noticeTarget(notice)).resolves.toBeUndefined();
  expect(f.call).not.toHaveBeenCalled();
  cleanup();
});

it("keeps cached responses read-only and does not repeat a lost answer", async () => {
  const f = fixture();
  await f.manager.refresh();
  f.online();
  const owner = f.manager.state().owner;
  if (!owner) throw new Error("missing_owner");
  const snapshot = f.manager.state().cell?.snapshot ?? blank;
  f.show({ status: "offline", readOnly: true, snapshot });
  await expect(f.manager.answer(owner, request, draft)).rejects.toThrow("cloud_offline");
  expect(f.call).not.toHaveBeenCalled();
  f.online();
  f.call.mockRejectedValueOnce(new OutcomeUnknownError("cloud_outcome_unknown"));
  await expect(f.manager.answer(owner, request, draft)).rejects.toThrow(OutcomeUnknownError);
  f.online();
  await expect(f.manager.answer(owner, request, draft)).rejects.toThrow("cloud_answer_pending");
  expect(f.call).toHaveBeenCalledExactlyOnceWith(
    "interaction.answer",
    {
      id: "request",
      version: 1,
      answer: { ...draft, by: { kind: "human", id: "member" }, at: expect.any(String) },
    },
    expect.stringMatching(/^answer:/),
  );
  f.online({ ...request, version: 2 });
  await expect(f.manager.answer(owner, request, draft)).rejects.toThrow("cloud_request_changed");
  await f.manager.answer(owner, { ...request, version: 2 }, draft);
  expect(f.call).toHaveBeenCalledTimes(2);
});

it("discards a registration that finishes after account replacement", async () => {
  const f = fixture();
  let finish = () => {};
  f.account.registerDevice.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const cleanup = f.manager.start();
  const previous = f.manager.refresh();
  await vi.waitFor(() => expect(f.account.registerDevice).toHaveBeenCalledOnce());
  f.change(signedIn("new-session", "new-org"));
  await f.manager.refresh();
  finish();
  await previous;
  expect(f.connection).toHaveBeenCalledTimes(1);
  expect(f.manager.state().owner).toMatchObject({ sessionId: "new-session", orgId: "new-org" });
  cleanup();
});

it("does not sign or send a changed Mac request while the phone key is loading", async () => {
  const f = fixture();
  await f.manager.refresh();
  const owner = f.manager.state().owner;
  if (!owner) throw new Error("missing_owner");
  const mac: Interaction = {
    ...request,
    type: "approval",
    turnId: "turn",
    items: [{ id: "approval", prompt: "Run on my Mac", choices: [{ id: "allow_once" }] }],
    context: {
      cwd: "/example/project",
      command: "uname",
      macExec: {
        v: 1,
        orgId: owner.orgId,
        userId: owner.userId,
        requestId: "mac-command",
        taskId: "task",
        turnId: "turn",
        targetDeviceId: "mac",
        scope: "command",
        command: "uname",
        cwd: "/example/project",
        stdinHash: approvalStdinHash(),
        timeoutSeconds: 600,
      },
    },
  };
  f.online(mac);
  let available = () => {};
  f.identity.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        available = () => resolve(f.device);
      }),
  );
  const pending = f.manager.answer(owner, mac, { action: "accept", choice: "allow_once" });
  f.online({ ...mac, version: 2 });
  available();
  await expect(pending).rejects.toThrow("cloud_request_changed");
  expect(f.call).not.toHaveBeenCalled();
});
