// B1: an agent may keep a browser profile, so it stays signed in between tasks.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CommandContext, type DomainState, handle, requestInteraction } from "@zoltbot/core";
import type { BrowserProfile, DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/** Rows only `browser.profile.*` and the launch path write (reserved from settings.set). */
export const BROWSER_PROFILE_PREFIX = "browser.profile.";
/** Present only in a kept profile folder; the launcher runs isolated without it. */
export const PROFILE_MARKER = ".zoltbot-profile";
/** After "Not now", the agent isn't asked again for a week. */
const ASK_AGAIN_MS = 7 * 24 * 60 * 60_000;

type ProfileRow =
  | { state: "asked"; interactionId: string; at: string }
  | { state: "declined"; at: string }
  | { state: "cleared"; at: string }
  | ({ state: "kept" } & BrowserProfile);

const key = (agentId: string) => `${BROWSER_PROFILE_PREFIX}${agentId}`;
export const profileRoot = (dataDir: string) => path.join(dataDir, "browser-profiles");
const profileDir = (dataDir: string, id: string) => {
  if (!/^[a-z0-9-]{8,64}$/.test(id)) throw Error("browser_profile_invalid");
  return path.join(profileRoot(dataDir), id);
};

function row(state: DomainState, agentId: string): ProfileRow | undefined {
  return state.settings?.find((r) => r.key === key(agentId))?.value as ProfileRow | undefined;
}

/** The kept profile, after folding in an answered approval. */
export function keptProfile(store: Store, agentId: string): BrowserProfile | undefined {
  const current = row(store.snapshot(["settings"]), agentId);
  if (current?.state !== "kept") return undefined;
  const { state: _state, ...profile } = current;
  return profile;
}

/** Chromium keeps a SingletonLock link in a profile folder while it has the folder open. */
function locked(dir: string) {
  try {
    lstatSync(path.join(dir, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}

// Like routine caps: any accepted "allow" counts, including an automatic system answer.
function answer(state: DomainState, interactionId: string) {
  const card = state.interaction?.find((r) => r.id === interactionId);
  if (!card) return "declined";
  if (card.state === "pending") return "pending";
  const resolution = card.resolution as
    | { action?: string; answers?: Record<string, { options?: string[] }> }
    | undefined;
  return resolution?.action === "accept" &&
    resolution.answers?.choice?.options?.includes("allow") === true
    ? "allow"
    : "declined";
}

export function profileApi(options: {
  store: Store;
  dataDir: string;
  publish?: (events: DomainEvent[]) => void;
  now?: () => Date;
  /** B2: closes any daemon-run browser using the profile before Clear deletes it. */
  closeBrowsers?: (profileId: string) => Promise<void>;
}) {
  const { store } = options;
  // Bindings compare folders against the real data path, so build them from it too.
  mkdirSync(options.dataDir, { recursive: true });
  const dataDir = realpathSync(options.dataDir);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const write = (
    commandId: string,
    work: (state: DomainState, context: CommandContext) => { events: DomainEvent[] }[],
  ) => {
    const before = store.lastSeq();
    store.dispatch(commandId, (state) => {
      const context = {
        commandId,
        at: now(),
        actor: { kind: "system" as const, id: "browser-profiles" },
      };
      const outcomes = work(state, context);
      return {
        events: outcomes
          .flatMap((o) => o.events)
          .map((e, i) => ({
            ...e,
            eventId: `${commandId}:${i}`,
          })),
        result: { ok: true },
      };
    });
    options.publish?.(store.eventsSince(before));
  };
  const setRow = (
    state: DomainState,
    agentId: string,
    value: ProfileRow,
    context: CommandContext,
  ) =>
    handle(
      state,
      state.settings?.some((r) => r.key === key(agentId))
        ? { type: "update", kind: "settings", id: key(agentId), changes: { value } }
        : { type: "create", kind: "settings", value: { key: key(agentId), value } },
      context,
    );
  const ensureFolder = (id: string) => {
    const dir = profileDir(dataDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw Error("browser_profile_invalid");
    writeFileSync(path.join(dir, PROFILE_MARKER), "", { mode: 0o600 });
    return dir;
  };

  /** Turns an answered approval into a record (Allow) or a declined row. */
  function settle(agentId: string, agentName: string) {
    const current = row(store.snapshot(["settings"]), agentId);
    if (current?.state !== "asked") return;
    const result = answer(store.snapshot(["interaction"]), current.interactionId);
    if (result === "pending") return;
    write(`browser-profile:${current.interactionId}:${result}`, (state, context) => {
      const latest = row(state, agentId);
      if (latest?.state !== "asked" || latest.interactionId !== current.interactionId) return [];
      const at = context.at;
      const value: ProfileRow =
        result === "allow"
          ? {
              state: "kept",
              id: randomUUID(),
              agentId,
              name: agentName,
              createdAt: at,
              lastUsedAt: at,
            }
          : { state: "declined", at };
      return [setRow(state, agentId, value, context)];
    });
  }

  return {
    settle,
    /**
     * The profile a launch should use, or undefined to run isolated. The first time, it asks the
     * owner (I13) and this launch runs isolated; Allow creates the record for the next launch.
     */
    forLaunch(input: { agentId: string; agentName: string; threadId: string }) {
      settle(input.agentId, input.agentName);
      const state = store.snapshot(["settings", "thread"]);
      const current = row(state, input.agentId);
      if (current?.state === "kept") {
        const dir = ensureFolder(current.id);
        write(`browser-profile:used:${current.id}:${now()}`, (s, context) => {
          const latest = row(s, input.agentId);
          return latest?.state === "kept"
            ? [setRow(s, input.agentId, { ...latest, lastUsedAt: context.at }, context)]
            : [];
        });
        return { id: current.id, dir };
      }
      if (current?.state === "asked") return undefined;
      if (
        current?.state === "declined" &&
        Date.parse(now()) - Date.parse(current.at) < ASK_AGAIN_MS
      )
        return undefined;
      const thread = state.thread?.find((t) => t.id === input.threadId);
      if (!thread || thread.agentId !== input.agentId) return undefined;
      const interactionId = `browser-profile:${input.agentId}:${randomUUID()}`;
      write(interactionId, (s, context) => {
        if (row(s, input.agentId)?.state === "asked") return [];
        const card = requestInteraction(
          s,
          {
            id: interactionId,
            agentId: input.agentId,
            threadId: input.threadId,
            type: "question",
            title: `Let ${input.agentName} keep a browser profile?`,
            chain: [{ kind: "system", id: "browser-profiles" }],
            urgency: "background",
            items: [
              {
                id: "choice",
                prompt: "It stays signed in to sites it visits.",
                options: [
                  { id: "allow", label: "Allow" },
                  { id: "not-now", label: "Not now" },
                ],
              },
            ],
          },
          `${interactionId}:item`,
          context,
        );
        return [
          card,
          setRow(s, input.agentId, { state: "asked", interactionId, at: context.at }, context),
        ];
      });
      return undefined;
    },
    get(agentId: string) {
      const name = String(store.record("agent", agentId)?.name ?? "");
      settle(agentId, name);
      return keptProfile(store, agentId) ?? null;
    },
    /** Deletes the profile folder and its record. Needs the owner's confirmation (I13). */
    async clear(agentId: string, confirmed: boolean) {
      if (confirmed !== true) throw Error("confirmation_required");
      const kept = keptProfile(store, agentId);
      if (!kept) return { ok: true, cleared: false };
      const dir = profileDir(dataDir, kept.id);
      await options.closeBrowsers?.(kept.id);
      // A browser still holding the folder would write the sign-ins back; refuse instead.
      if (locked(dir)) throw Error("browser_profile_in_use");
      // The marker goes first, so a launch racing the delete runs isolated.
      rmSync(path.join(dir, PROFILE_MARKER), { force: true });
      rmSync(dir, { recursive: true, force: true });
      if (existsSync(dir)) throw Error("browser_profile_clear_failed");
      write(`browser-profile:clear:${kept.id}`, (state, context) => [
        setRow(state, agentId, { state: "cleared", at: context.at }, context),
        handle(
          state,
          {
            type: "create",
            kind: "audit",
            value: {
              id: `browser-profile:clear:${kept.id}`,
              actor: { kind: "human", id: "local-owner" },
              action: "browser.profile.clear",
              target: agentId,
              result: "authorized",
              detail: { confirmed: true },
              at: context.at,
            },
          },
          context,
        ),
      ]);
      return { ok: true, cleared: true };
    },
  };
}
