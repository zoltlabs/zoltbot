// After Clear, the Zolt chat the person is watching while Zolt writes its handoff. The chat
// screen moves to Zolt's new chat once the daemon switches to it.
let leaving: string | undefined;

export function followChiefClear(threadId: string): void {
  leaving = threadId;
}

/** Zolt's new chat to open instead of `threadId`, once, when a clear left it. */
export function chiefClearTarget(threadId: string, chief: string | undefined): string | undefined {
  if (leaving !== threadId || !chief || chief === threadId) return undefined;
  leaving = undefined;
  return chief;
}
