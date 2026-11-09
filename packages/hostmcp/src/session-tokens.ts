import { createHash, randomBytes } from "node:crypto";

export interface SessionIdentity {
  agentId: string;
  threadId: string;
  sessionId: string;
}
export interface ToolActor extends SessionIdentity {
  turnId?: string;
}
const validId = (value: string) => value.length > 0 && value.length <= 256;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** In-memory authority only. Bearer values never enter durable state or audit data. */
export class SessionTokens {
  private readonly actors = new Map<string, ToolActor>();
  private readonly sessions = new Map<string, string>();
  private closed = false;

  issue(identity: SessionIdentity): string {
    if (this.closed) throw new Error("session_tokens_closed");
    if (![identity.agentId, identity.threadId, identity.sessionId].every(validId))
      throw new Error("invalid_session_identity");
    if (this.sessions.has(identity.sessionId)) throw new Error("session_token_exists");
    const token = randomBytes(32).toString("base64url");
    const key = digest(token);
    this.actors.set(key, {
      agentId: identity.agentId,
      threadId: identity.threadId,
      sessionId: identity.sessionId,
    });
    this.sessions.set(identity.sessionId, key);
    return token;
  }

  authenticate(authorization: string | undefined): ToolActor | undefined {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    // JS $ permits a final newline. Require the complete header to match as well.
    if (!match || match[0] !== authorization || !match[1]) return undefined;
    const actor = this.actors.get(digest(match[1]));
    return actor ? { ...actor } : undefined;
  }

  setTurn(sessionId: string, turnId: string | undefined): void {
    const key = this.sessions.get(sessionId);
    const actor = key ? this.actors.get(key) : undefined;
    if (!actor) throw new Error("session_token_unavailable");
    if (turnId !== undefined && !validId(turnId)) throw new Error("invalid_turn_identity");
    if (turnId === undefined) delete actor.turnId;
    else actor.turnId = turnId;
  }

  revoke(sessionId: string): void {
    const key = this.sessions.get(sessionId);
    if (key) this.actors.delete(key);
    this.sessions.delete(sessionId);
  }

  close(): void {
    this.closed = true;
    this.actors.clear();
    this.sessions.clear();
  }
}
