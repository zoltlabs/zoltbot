import type { NativeOwner } from "./native-owner.js";

export interface AdoptionRequest {
  provider: string;
  nativeId: string;
  agentId: string;
  choice: "adopt" | "fork" | "wait";
  confirmed: boolean;
}
interface NativeHandle {
  nativeId: string;
  close(): Promise<void>;
}
export interface AdoptionHost {
  inspect(request: AdoptionRequest): Promise<NativeOwner>;
  open(mode: "resume" | "fork", request: AdoptionRequest): Promise<NativeHandle>;
  /** Atomically persist the link and retain this runtime handle only on success. */
  commit(handle: NativeHandle, request: AdoptionRequest): Promise<{ threadId: string }>;
}
export class NativeAdoption {
  private readonly active = new Set<string>();
  constructor(private readonly host: AdoptionHost) {}
  async run(input: AdoptionRequest) {
    const request = { ...input };
    if (!request.confirmed) throw new Error("adoption_confirmation_required");
    if (
      !["adopt", "fork", "wait"].includes(request.choice) ||
      !request.nativeId ||
      !request.provider ||
      !request.agentId
    )
      throw new Error("invalid_adoption_request");
    if (request.choice === "wait") return { state: "waiting" as const };
    const key = JSON.stringify([request.provider, request.nativeId]);
    if (this.active.has(key)) throw new Error("native_adoption_in_progress");
    this.active.add(key);
    let handle: NativeHandle | undefined;
    try {
      const owner = await this.host.inspect(request);
      if (request.choice === "adopt" && owner.state !== "clear")
        return {
          state: "blocked" as const,
          recommendation: "fork" as const,
          options: ["fork", "wait"],
        };
      handle = await this.host.open(request.choice === "fork" ? "fork" : "resume", request);
      if (request.choice === "fork" && handle.nativeId === request.nativeId)
        throw new Error("fork_identity_unchanged");
      if (request.choice === "adopt" && handle.nativeId !== request.nativeId)
        throw new Error("resume_identity_changed");
      const link = await this.host.commit(handle, request);
      return { state: "adopted" as const, nativeId: handle.nativeId, threadId: link.threadId };
    } catch (error) {
      await handle?.close();
      throw error;
    } finally {
      this.active.delete(key);
    }
  }
}
