import type { ArtifactTarget } from "@zoltbot/protocol";
import { create } from "zustand";

type Draft = { threadId: string; text: string; target: ArtifactTarget };
/** A single-use handoff avoids URL parameters replaying on focus or replacing an existing draft. */
export const useChatDraft = create<{
  draft: Draft | undefined;
  prepare(threadId: string, text: string, target: ArtifactTarget): void;
  take(threadId: string): Draft | undefined;
}>((set, get) => ({
  draft: undefined,
  prepare: (threadId, text, target) => set({ draft: { threadId, text, target } }),
  take: (threadId) => {
    const draft = get().draft;
    if (draft?.threadId !== threadId) return undefined;
    set({ draft: undefined });
    return draft;
  },
}));
