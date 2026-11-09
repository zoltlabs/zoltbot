import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { redactBrowserText } from "./browser/redaction.js";

/** Credential shapes: the knowledge write policy rejects them and logs never keep them. */
export const credentialShapes = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const personalKey = /^(?:account|email|username|organization)$/i;
const secretKey = /(?:token|password|secret|authorization|api[_-]?key|credential)/i;
export class Redactor {
  private readonly secrets = new Set<string>();
  private readonly prefixes = new Map<string, Int32Array>();
  private privateFrames = false;
  private browserUrls = false;
  hideBrowserUrls() {
    this.browserUrls = true;
  }
  constructor(values: string[] = []) {
    for (const value of values) this.register(value);
  }
  register(value: string) {
    if (!value || this.secrets.has(value)) return;
    this.secrets.add(value);
    const prefix = new Int32Array(value.length);
    for (let index = 1, matched = 0; index < value.length; index++) {
      while (matched && value[index] !== value[matched]) matched = prefix[matched - 1] ?? 0;
      if (value[index] === value[matched]) matched++;
      prefix[index] = matched;
    }
    this.prefixes.set(value, prefix);
  }
  hideFrames() {
    this.privateFrames = true;
  }
  get hidesFrames() {
    return this.privateFrames;
  }
  /** Safe visible prefix of accumulated text; incomplete private prefixes stay buffered. */
  streamText(value: string, complete = false): string {
    if (complete) return this.text(value);
    let cut = value.length;
    for (const [secret, prefix] of this.prefixes) {
      if (secret.length < 2) continue;
      let matched = 0;
      for (
        let index = Math.max(0, value.length - secret.length + 1);
        index < value.length;
        index++
      ) {
        while (matched && value[index] !== secret[matched]) matched = prefix[matched - 1] ?? 0;
        if (value[index] === secret[matched]) matched++;
      }
      cut = Math.min(cut, value.length - matched);
    }
    let previous: number;
    do {
      previous = cut;
      for (const secret of this.secrets) {
        const start = value.lastIndexOf(secret, cut - 1);
        if (start >= 0 && start < cut && start + secret.length > cut) cut = start;
      }
    } while (cut !== previous);
    return this.text(value.slice(0, cut));
  }
  text(value: string): string {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[redacted]");
    result = result
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
    return this.browserUrls ? redactBrowserText(result) : result;
  }
  value<T>(value: T): T {
    const visit = (v: unknown, image = false): unknown => {
      if (typeof v === "string") return this.text(v);
      if ((typeof v === "number" || typeof v === "boolean") && this.secrets.has(String(v)))
        return "[redacted]";
      if (Array.isArray(v)) return v.map((item) => visit(item, image));
      if (v && typeof v === "object") {
        const imagePayload =
          image || ["image", "input_image"].includes(String((v as Record<string, unknown>).type));
        return Object.fromEntries(
          Object.entries(v).map(([k, item]) => [
            this.text(k),
            imagePayload && /^(?:data|base64|url)$/.test(k) && typeof item === "string"
              ? "[image omitted]"
              : (personalKey.test(k) || secretKey.test(k)) &&
                  k !== "apiKeyEnv" &&
                  !/(?:tokens|tokenEstimate|injectedTokens|budgetTokens)$/i.test(k)
                ? "[redacted]"
                : visit(item, imagePayload),
          ]),
        );
      }
      return v;
    };
    return visit(value) as T;
  }
}
export class Logger {
  readonly lines: string[] = [];
  constructor(
    private readonly file: string,
    readonly redactor: Redactor,
  ) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  write(level: "info" | "warn" | "error", message: string, detail: unknown = {}) {
    const line = credentialShapes.reduce(
      (text, shape) => text.replace(new RegExp(shape.source, `${shape.flags}g`), "[redacted]"),
      JSON.stringify({
        at: new Date().toISOString(),
        level,
        message: this.redactor.text(message),
        detail: this.redactor.value(detail),
      }),
    );
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.shift();
    appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
  }
}
