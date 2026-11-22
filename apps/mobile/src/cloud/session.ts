import { type Identity, linkId, randomId, toB64 } from "@zoltbot/link";
import type { Interaction } from "@zoltbot/protocol";
import type { AnswerDraft } from "../data/interactions.js";
import type { PushResponse } from "../data/push.js";
import { OutcomeUnknownError } from "../data/transport.js";
import type { PhoneAccountStatus, PhoneCellConnection, phoneAccount } from "./account.js";
import type { PhoneCloudState, phoneCloudConnection } from "./connection.js";
import { cloudAnswer, cloudRequests } from "./needs-you.js";

type Account = Pick<
  ReturnType<typeof phoneAccount>,
  "status" | "sessionId" | "subscribe" | "registerDevice" | "signIn" | "cancelSignIn" | "signOut"
>;
type Owner = PhoneCellConnection["owner"];
type Connection = ReturnType<typeof phoneCloudConnection>;

export interface CloudSessionState {
  checked: boolean;
  account: PhoneAccountStatus;
  owner?: Owner | undefined;
  cell?: PhoneCloudState | undefined;
  error?: "cloud_access" | "cloud_account" | undefined;
}

export function phoneCloudSession(options: {
  configured: boolean;
  account: Account;
  identity(): Promise<Identity>;
  connection(owner: Owner): Connection;
  publish(state: CloudSessionState): void;
}) {
  const { account } = options;
  let state: CloudSessionState = {
    checked: !options.configured,
    account: { configured: options.configured, signedIn: false, online: false },
  };
  let generation = 0;
  let checking: { generation: number; promise: Promise<void> } | undefined;
  let connection: Connection | undefined;
  let stopConnection: (() => void) | undefined;
  const answers = new Set<string>();

  const put = (next: Partial<CloudSessionState>) => {
    state = { ...state, ...next };
    options.publish(state);
  };

  function clearConnection() {
    stopConnection?.();
    stopConnection = undefined;
    const previous = connection;
    connection = undefined;
    previous?.stop();
    answers.clear();
    put({ owner: undefined, cell: undefined });
  }

  const allowed = (current: number, sessionId: string) =>
    current === generation && account.sessionId() === sessionId;

  async function reconcile() {
    const current = generation;
    let status: PhoneAccountStatus;
    try {
      status = await account.status();
    } catch {
      if (current !== generation) return;
      clearConnection();
      put({
        checked: true,
        account: {
          configured: state.account.configured,
          signedIn: state.account.signedIn,
          online: false,
          ...(state.account.sessionId ? { sessionId: state.account.sessionId } : {}),
        },
        error: "cloud_account",
      });
      return;
    }
    if (current !== generation) return;
    const member = status.account;
    const personal = member?.organizations.find((org) => org.kind === "personal");
    const sameOwner =
      state.owner &&
      status.sessionId === state.owner.sessionId &&
      (!member || (member.user.id === state.owner.userId && personal?.id === state.owner.orgId));
    if (!sameOwner) clearConnection();
    put({
      checked: true,
      account: status,
      error: member && !personal ? "cloud_access" : undefined,
    });
    if (!member || !personal || (sameOwner && connection)) return;
    const sessionId = member.sessionId;
    if (!allowed(current, sessionId)) return;
    try {
      const identity = await options.identity();
      const registered = {
        deviceId: linkId(identity.publicKey),
        publicKey: toB64(identity.publicKey),
      };
      if (!allowed(current, sessionId)) return;
      await account.registerDevice(sessionId, registered);
      if (!allowed(current, sessionId)) return;
      const owner = {
        userId: member.user.id,
        orgId: personal.id,
        sessionId,
        deviceId: registered.deviceId,
      };
      const next = options.connection(owner);
      connection = next;
      put({ owner });
      stopConnection = next.subscribe((cell) => {
        if (next !== connection || !allowed(current, sessionId)) return;
        if (!cell.readOnly) {
          const pending = new Set(cloudRequests(cell.snapshot).map(interactionKey));
          for (const key of answers) if (!pending.has(key)) answers.delete(key);
        }
        put({ cell });
      });
      next.start();
    } catch {
      if (allowed(current, sessionId)) put({ error: "cloud_access" });
    }
  }

  function refresh(): Promise<void> {
    if (!options.configured) return Promise.resolve();
    if (checking?.generation === generation) return checking.promise;
    const current = generation;
    const promise = reconcile().finally(() => {
      if (checking?.promise === promise) checking = undefined;
    });
    checking = { generation: current, promise };
    return promise;
  }

  function interactionKey(request: Interaction) {
    return `${request.id}:${request.version}`;
  }

  return {
    state: () => state,
    refresh,
    retry() {
      if (state.cell?.error === "cloud_authority_refused") {
        generation++;
        clearConnection();
      }
      return refresh();
    },
    start() {
      const unsubscribe = account.subscribe(() => {
        generation++;
        clearConnection();
        void refresh();
      });
      void refresh();
      return () => {
        unsubscribe();
        generation++;
        clearConnection();
      };
    },
    async noticeTarget(notice: Extract<PushResponse, { kind: "open_cloud" }>) {
      if (!state.owner) await refresh();
      const owner = state.owner;
      if (
        owner?.orgId !== notice.orgId ||
        owner.sessionId !== account.sessionId() ||
        state.cell?.error === "cloud_authority_refused"
      )
        return;
      return { orgId: notice.orgId, threadId: notice.threadId };
    },
    async signIn() {
      await account.signIn();
      await refresh();
    },
    cancelSignIn: account.cancelSignIn,
    async signOut(sessionId: string) {
      try {
        await account.signOut(sessionId);
      } finally {
        await refresh();
      }
    },
    async answer(owner: Owner, rendered: Interaction, draft: AnswerDraft) {
      const active = connection;
      if (!active) throw new Error("cloud_offline");
      const current = () => {
        if (
          active !== connection ||
          state.owner !== owner ||
          account.sessionId() !== owner.sessionId ||
          !state.cell ||
          state.cell.readOnly
        )
          throw new Error("cloud_offline");
        const live = cloudRequests(state.cell.snapshot, rendered.threadId).find(
          (request) => request.id === rendered.id,
        );
        if (!live || JSON.stringify(live) !== JSON.stringify(rendered))
          throw new Error("cloud_request_changed");
        return live;
      };
      const request = current();
      const key = interactionKey(request);
      if (answers.has(key)) throw new Error("cloud_answer_pending");
      answers.add(key);
      try {
        const identity =
          request.context?.macExec && draft.action === "accept"
            ? await options.identity()
            : undefined;
        current();
        const answer = cloudAnswer(owner, request, draft, identity);
        await active.call(
          "interaction.answer",
          { id: request.id, version: request.version, answer },
          `answer:${randomId()}`,
        );
      } catch (error) {
        if (!(error instanceof OutcomeUnknownError) && active === connection) answers.delete(key);
        throw error;
      }
    },
  };
}
