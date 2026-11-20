// S1: the artifact panel's Share calls. Checks the account, runs the cloud account's artifact
// calls, keeps which online copy belongs to which artifact, and turns error codes into sentences.
import { randomUUID } from "node:crypto";
import type {
  ArtifactLink,
  ArtifactShareRecord,
  ArtifactShareState,
  ArtifactShareTarget,
  ArtifactVisibility,
} from "../../shared/artifact-share";
import { artifactShareKey, ARTIFACT_SHARE_CHANNELS as C } from "../../shared/artifact-share";
import type { DaemonClient } from "../../zolt/daemon-client";
import type { cloudAccount } from "./cloud-account";

type Account = Pick<
  ReturnType<typeof cloudAccount>,
  | "status"
  | "artifactLink"
  | "uploadArtifact"
  | "setArtifactVisibility"
  | "deleteArtifact"
  | "copyArtifactLink"
>;

/** Where each artifact's online copy is recorded. */
export interface ShareRecords {
  get(artifactId: string): ArtifactShareRecord | null;
  set(artifactId: string, record: ArtifactShareRecord | null): Promise<void>;
}

/** Records kept as daemon settings, so they follow the daemon and reach the phone. */
export function daemonShareRecords(client: Pick<DaemonClient, "rows" | "call">): ShareRecords {
  return {
    get(artifactId) {
      const row = client.rows("settings").find((item) => item.key === artifactShareKey(artifactId));
      const value = row?.value as Partial<ArtifactShareRecord> | null | undefined;
      return value && typeof value.id === "string" && typeof value.manifestHash === "string"
        ? (value as ArtifactShareRecord)
        : null;
    },
    async set(artifactId, record) {
      await client.call(
        "settings.set",
        { key: artifactShareKey(artifactId), value: record },
        randomUUID(),
      );
    },
  };
}

const INVALID = "Couldn’t share this artifact. Reopen it and try again.";
const SECRET =
  "This artifact may contain a secret, so it wasn’t published. Remove it and try again.";
const COMMON: Record<string, string> = {
  invalid_input: INVALID,
  possible_secret: SECRET,
  sign_in_required: "Sign in again to share.",
  account_access_revoked: "Sign in again to share.",
  artifact_corrupt: "This artifact’s files changed on this Mac. Reopen it and try again.",
  link_changed: "This link changed. Close Share and open it again.",
};

/** Runs `work`, turning a failure into `fallback` unless its code has its own sentence. */
async function friendly<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(COMMON[code] ?? fallback);
  }
}

function target(input: unknown): ArtifactShareTarget {
  const value = (input ?? {}) as Record<string, unknown>;
  if (
    typeof value.artifactId !== "string" ||
    !value.artifactId ||
    value.artifactId.length > 200 ||
    typeof value.manifestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.manifestHash) ||
    typeof value.title !== "string" ||
    value.title.length > 200
  )
    throw new Error("invalid_input");
  return { artifactId: value.artifactId, manifestHash: value.manifestHash, title: value.title };
}

function visibility(input: unknown): ArtifactVisibility {
  const value = (input as { visibility?: unknown } | undefined)?.visibility;
  if (value !== "private" && value !== "public") throw new Error("invalid_input");
  return value;
}

/** The account the panel can publish with, or why it can't. */
async function ready(account: Account) {
  const status = (await account.status()) as {
    configured?: boolean;
    signedIn?: boolean;
    account?: {
      capabilities?: { privateArtifacts?: boolean };
      organizations?: { id?: unknown }[];
    };
  };
  if (!status.configured) return { kind: "unavailable" as const };
  if (!status.signedIn) return { kind: "signed-out" as const };
  const orgId = status.account?.organizations?.[0]?.id;
  if (!status.account?.capabilities?.privateArtifacts || typeof orgId !== "string")
    return { kind: "unavailable" as const };
  return { kind: "ready" as const, orgId };
}

const toLink = (record: ArtifactShareRecord, item: ArtifactShareTarget): ArtifactLink => ({
  id: record.id,
  visibility: record.visibility,
  url: record.url,
  current: record.manifestHash === item.manifestHash,
});

export function artifactShareHandlers(
  account: Account,
  records: ShareRecords,
): Record<string, (input: unknown) => unknown> {
  /** The recorded link for this artifact; a renderer can never name another copy. */
  function recorded(item: ArtifactShareTarget) {
    const record = records.get(item.artifactId);
    if (!record) throw new Error("link_changed");
    return record;
  }

  async function publish(item: ArtifactShareTarget, choice: ArtifactVisibility) {
    const state = await ready(account);
    if (state.kind !== "ready") throw new Error("sign_in_required");
    // A fresh key each time: republishing after Unpublish must not reuse the deleted upload.
    let online = await account.uploadArtifact(
      item.manifestHash,
      item.title,
      state.orgId,
      true,
      randomUUID(),
    );
    if (choice !== online.visibility)
      online = await account.setArtifactVisibility({
        id: online.id,
        hash: item.manifestHash,
        title: item.title,
        visibility: choice,
        confirm: true,
      });
    const record = { ...online, manifestHash: item.manifestHash };
    await records.set(item.artifactId, record);
    return toLink(record, item);
  }

  return {
    [C.artifactShareStatus]: (input) =>
      friendly("Couldn’t check sharing. Check your connection and try again.", async () => {
        const item = target(input);
        const state = await ready(account);
        if (state.kind !== "ready") return state satisfies ArtifactShareState;
        const record = records.get(item.artifactId);
        if (!record) return { kind: "ready", link: null } satisfies ArtifactShareState;
        // Visibility can change on the web; offline, the recorded link still shows.
        const online = await account
          .artifactLink(record.id, item.manifestHash)
          .catch(() => toLink(record, item));
        return { kind: "ready", link: online } satisfies ArtifactShareState;
      }),
    [C.artifactSharePublish]: (input) =>
      friendly("Couldn’t publish. Check your connection and try again.", () => {
        const item = target(input);
        if (records.get(item.artifactId)) throw new Error("link_changed");
        return publish(item, visibility(input));
      }),
    [C.artifactShareSetVisibility]: (input) =>
      friendly("Couldn’t change who can open the link. Try again.", async () => {
        const item = target(input);
        const record = recorded(item);
        if (record.manifestHash !== item.manifestHash) throw new Error("link_changed");
        const online = await account.setArtifactVisibility({
          id: record.id,
          hash: item.manifestHash,
          title: item.title,
          visibility: visibility(input),
          confirm: true,
        });
        const next = { ...record, visibility: online.visibility };
        await records.set(item.artifactId, next);
        return toLink(next, item);
      }),
    [C.artifactShareReplace]: (input) =>
      friendly("Couldn’t publish. Check your connection and try again.", async () => {
        const item = target(input);
        const old = recorded(item);
        // The old copy goes first, so a failed upload never leaves two live copies.
        await account.deleteArtifact(old.id);
        await records.set(item.artifactId, null);
        return publish(item, old.visibility);
      }),
    [C.artifactShareUnpublish]: (input) =>
      friendly("Couldn’t unpublish. Check your connection and try again.", async () => {
        const item = target(input);
        await account.deleteArtifact(recorded(item).id);
        await records.set(item.artifactId, null);
      }),
    [C.artifactShareCopy]: (input) =>
      friendly("Couldn’t copy the link. Try again.", async () => {
        await account.copyArtifactLink(recorded(target(input)).id);
      }),
  };
}
