import type { NativeSessionInfo } from "@zoltbot/protocol";

type Filter = { cwd?: string };
interface IndexHost {
  /** Return a complete listing, after all provider pages succeed. */
  list(provider: string, filter: Filter): Promise<NativeSessionInfo[]>;
  commit(provider: string, sessions: NativeSessionInfo[], filter: Filter): Promise<void>;
  now?: () => number;
}
export class NativeSessionIndex {
  private readonly active = new Map<string, Promise<void>>();
  private readonly providers = new Map<string, Promise<void>>();
  private readonly completed = new Map<string, number>();
  constructor(private readonly host: IndexHost) {}

  refresh(provider: string, reason: "launch" | "focus" | "panel", filter: Filter = {}) {
    const scope = { ...filter };
    const key = JSON.stringify([provider, scope.cwd ?? null]);
    const active = this.active.get(key);
    if (active) return active;
    const now = this.host.now ?? Date.now;
    const last = this.completed.get(key);
    if (reason === "focus" && last !== undefined && now() - last < 30000) return Promise.resolve();
    // Serialize listings and commits for a provider so folder and full scans cannot overtake each other.
    const previous = this.providers.get(provider) ?? Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        const sessions = await this.host.list(provider, scope);
        await this.host.commit(provider, sessions, scope);
        this.completed.set(key, now());
      });
    const result = work.finally(() => {
      this.active.delete(key);
      if (this.providers.get(provider) === result) this.providers.delete(provider);
    });
    this.active.set(key, result);
    this.providers.set(provider, result);
    return result;
  }
}
