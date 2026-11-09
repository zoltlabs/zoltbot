import type { DomainState } from "@zoltbot/core";
import {
  assertNoPrivateValue,
  type DomainEvent,
  type Interaction,
  type InteractionAnswer,
  publicAnswerData,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { connectionCredentialReferences } from "./connections-private.js";
import { credentialShapes, type Redactor } from "./logging.js";
import { PrivateContexts, type PrivateVault } from "./private-context.js";
import { protectedCredentialReferences } from "./runtime-credentials.js";

const secretShapes = credentialShapes;
export type PublicWriteCheck = (state: DomainState) => void;
export class PrivateInputGuard {
  readonly contexts: PrivateContexts | undefined;
  private readonly values = new Set<string>();
  private readonly covered = new Set<string>();
  private readonly redactors = new Set<WeakRef<Redactor>>();
  private privateFrames = false;
  constructor(
    private readonly options: {
      store: Store;
      secrets?: PrivateVault;
      publish(events: DomainEvent[]): void;
    },
  ) {
    if (options.secrets)
      this.contexts = new PrivateContexts({
        store: options.store,
        vault: options.secrets,
        publish: options.publish,
      });
  }
  track(redactor: Redactor) {
    this.eachRedactor(() => {});
    this.redactors.add(new WeakRef(redactor));
    for (const value of this.values) redactor.register(value);
    if (this.privateFrames) redactor.hideFrames();
  }
  private eachRedactor(visit: (redactor: Redactor) => void) {
    for (const reference of this.redactors) {
      const redactor = reference.deref();
      if (redactor) visit(redactor);
      else this.redactors.delete(reference);
    }
  }
  hideFrames() {
    this.privateFrames = true;
    this.eachRedactor((redactor) => redactor.hideFrames());
  }
  remember(value: string) {
    if (!value || this.values.has(value)) return;
    this.values.add(value);
    this.hideFrames();
    this.eachRedactor((redactor) => redactor.register(value));
  }
  cover(sessionId: string) {
    this.covered.add(sessionId);
  }
  /**
   * Knowledge write policy row 1: vault values, remembered private values, every tracked session
   * redactor (known secrets plus its patterns) and common credential shapes. Never stores text.
   */
  async containsSecret(value: unknown): Promise<boolean> {
    const texts: string[] = [];
    const visit = (item: unknown) => {
      if (typeof item === "string") texts.push(item);
      else if (Array.isArray(item)) item.forEach(visit);
      else if (item && typeof item === "object") Object.values(item).forEach(visit);
    };
    visit(value);
    const protectedValues = await this.contexts?.known(this.covered);
    const known = [...this.values, ...(protectedValues?.values ?? [])].filter(Boolean);
    if (texts.some((text) => known.some((secret) => text.includes(secret)))) return true;
    let redacted = false;
    this.eachRedactor((redactor) => {
      redacted ||= texts.some((text) => redactor.text(text) !== text);
    });
    return redacted || texts.some((text) => secretShapes.some((shape) => shape.test(text)));
  }
  prepareData(value: unknown): Promise<PublicWriteCheck> {
    return this.prepare([value]);
  }
  prepareInput(input: UserInput): Promise<PublicWriteCheck> {
    return this.prepare(
      input.map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "file"
            ? part.path
            : [part.path, part.base64],
      ),
    );
  }
  prepareAnswer(request: Interaction, answer: InteractionAnswer): Promise<PublicWriteCheck> {
    return this.prepare(publicAnswerData(request, answer));
  }
  private async prepare(data: unknown[]): Promise<PublicWriteCheck> {
    if (!data.length) return () => {};
    assertNoPrivateValue(data, this.values);
    const protectedValues = await this.contexts?.known(this.covered);
    if (protectedValues) {
      if (protectedValues.stamp !== "[]") this.hideFrames();
      for (const value of protectedValues.values) this.remember(value);
    }
    const check: PublicWriteCheck = (state) => {
      if (
        !this.contexts &&
        (protectedCredentialReferences(state).length ||
          connectionCredentialReferences(this.options.store).length)
      )
        throw new Error("runtime_credentials_unavailable");
      if (this.contexts && protectedValues && this.contexts.stamp(state) !== protectedValues.stamp)
        throw new Error("private_context_changed");
      if (
        !this.contexts &&
        state.settings?.some((row) => {
          const key = String(row.key),
            prefix = key.startsWith("runtime.privateRef.")
              ? "runtime.privateRef."
              : key.startsWith("runtime.private.") && row.value === true
                ? "runtime.private."
                : undefined;
          return prefix && !this.covered.has(key.slice(prefix.length));
        })
      )
        throw new Error("runtime_private_context_required");
      assertNoPrivateValue(data, protectedValues?.values ?? []);
      assertNoPrivateValue(data, this.values);
    };
    check(this.options.store.snapshot(["settings", "agentDefinition"]));
    return check;
  }
}
