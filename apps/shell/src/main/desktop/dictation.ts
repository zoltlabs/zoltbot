import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export type DictationAccessStatus = "authorized" | "not_determined" | "denied" | "restricted";

export interface DictationStatus {
  available: boolean;
  onDevice: boolean;
  locale: string;
  microphone: DictationAccessStatus;
  speech: DictationAccessStatus;
}

export interface DictationStartOptions {
  locale?: string;
  onDevice?: boolean;
  source?: "pcm16le" | "microphone";
  contextualStrings?: string[];
}

export interface DictationEvent {
  sessionId: string;
  kind: "partial" | "final" | "error" | "stopped";
  text?: string;
  code?: string;
  message?: string;
  reason?: string;
}

const maxAudioBytes = 3_840_000;
const maxChunkBytes = 65_536;
const maxLineBytes = 65_536;
const maxTranscriptChars = 16_000;

export function sanitizeLocale(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 32 || !/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z0-9]{2,8}){0,2}$/.test(trimmed))
    throw new Error("invalid_dictation_locale");
  return trimmed.replaceAll("_", "-");
}

export function sanitizeContextualStrings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("invalid_contextual_strings");
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const cleaned = entry.replace(/\p{Cc}/gu, "").trim();
    if (
      cleaned.length < 2 ||
      cleaned.length > 80 ||
      /[=:\\]/.test(cleaned) ||
      /^(?:sk-|ghp_|xox[baprs]-|AIza|Bearer\s)/i.test(cleaned) ||
      seen.has(cleaned)
    )
      continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAccess(value: unknown): DictationAccessStatus {
  if (
    value === "authorized" ||
    value === "not_determined" ||
    value === "denied" ||
    value === "restricted"
  )
    return value;
  if (value === "granted") return "authorized";
  if (value === "not-determined" || value === "unknown") return "not_determined";
  return "denied";
}

function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export interface DictationControllerOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  maxDurationMs?: number;
  finalizeTimeoutMs?: number;
  statusTimeoutMs?: number;
  microphoneStatus?: () => Promise<DictationAccessStatus> | DictationAccessStatus;
  requestMicrophoneAccess?: () => Promise<boolean>;
  onEvent: (event: DictationEvent) => void;
}

interface ActiveSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  writtenBytes: number;
  closing: boolean;
  cancelled: boolean;
  stoppedEmitted: boolean;
  durationTimer: ReturnType<typeof setTimeout>;
  finalizeTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  terminate: (reason?: string) => void;
}

export function createDictationController(options: DictationControllerOptions) {
  let active: ActiveSession | undefined;

  const runOneShot = async (
    op: "status" | "request_permission",
    locale: string,
  ): Promise<DictationStatus> => {
    const micOverride = options.microphoneStatus ? await options.microphoneStatus() : undefined;
    return await new Promise<DictationStatus>((resolve) => {
      const fallback = (): DictationStatus => ({
        available: false,
        onDevice: false,
        locale: locale || "en-US",
        microphone: micOverride ?? "not_determined",
        speech: "not_determined",
      });
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(options.command, [...(options.args ?? [])], {
          cwd: options.cwd,
          env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          shell: false,
        });
      } catch {
        resolve(fallback());
        return;
      }
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (status: DictationStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve(status);
      };
      const abort = () => {
        if (settled) return;
        killProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 300);
        finish(fallback());
      };
      const timer = setTimeout(abort, options.statusTimeoutMs ?? 5000);
      child.on("error", abort);
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxLineBytes) abort();
        else chunks.push(chunk);
      });
      child.once("close", () => {
        if (settled) return;
        try {
          const line = Buffer.concat(chunks).toString("utf8").trim().split("\n")[0] ?? "";
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const helperMic = normalizeAccess(parsed.microphone);
          finish({
            available: parsed.available === true,
            onDevice: parsed.onDevice === true,
            locale:
              typeof parsed.locale === "string" && parsed.locale
                ? parsed.locale
                : locale || "en-US",
            microphone: micOverride && micOverride !== "not_determined" ? micOverride : helperMic,
            speech: normalizeAccess(parsed.speech),
          });
        } catch {
          finish(fallback());
        }
      });
      child.stdin.end(`${JSON.stringify({ op, ...(locale ? { locale } : {}) })}\n`);
    });
  };

  return {
    async status(params?: { locale?: unknown }): Promise<DictationStatus> {
      const locale = sanitizeLocale(params?.locale);
      return runOneShot("status", locale);
    },

    async requestPermission(params?: { locale?: unknown }): Promise<DictationStatus> {
      const locale = sanitizeLocale(params?.locale);
      if (options.requestMicrophoneAccess) {
        try {
          await options.requestMicrophoneAccess();
        } catch {}
      }
      return runOneShot("request_permission", locale);
    },

    async start(raw?: DictationStartOptions): Promise<{ sessionId: string }> {
      const locale = sanitizeLocale(raw?.locale);
      const onDevice = raw?.onDevice !== false;
      const source = raw?.source === "microphone" ? "microphone" : "pcm16le";
      const contextualStrings = sanitizeContextualStrings(raw?.contextualStrings);

      if (active) active.terminate("superseded");

      const sessionId = randomUUID();
      const child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        shell: false,
      });

      const emitOnceStopped = (reason?: string) => {
        if (session.stoppedEmitted) return;
        session.stoppedEmitted = true;
        options.onEvent({
          sessionId,
          kind: "stopped",
          ...(reason ? { reason } : {}),
        });
      };

      const terminate = (reason?: string) => {
        clearTimeout(session.durationTimer);
        clearTimeout(session.finalizeTimer);
        if (active?.id === sessionId) active = undefined;
        killProcessGroup(child, "SIGTERM");
        session.killTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 500);
        emitOnceStopped(reason);
      };

      const durationTimer = setTimeout(() => {
        if (active?.id !== sessionId) return;
        session.closing = true;
        try {
          child.stdin.end();
        } catch {}
        session.finalizeTimer = setTimeout(
          () => terminate("duration_limit"),
          options.finalizeTimeoutMs ?? 1500,
        );
      }, options.maxDurationMs ?? 120_000);

      const session: ActiveSession = {
        id: sessionId,
        child,
        writtenBytes: 0,
        closing: false,
        cancelled: false,
        stoppedEmitted: false,
        durationTimer,
        terminate,
      };
      active = session;

      let lineBuffer = "";
      const handleLine = (line: string) => {
        if (!line.trim() || session.cancelled) return;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          options.onEvent({
            sessionId,
            kind: "error",
            code: "invalid_helper_output",
            message: "Speech helper returned invalid output.",
          });
          terminate("invalid_output");
          return;
        }
        const kind = parsed.kind;
        if (kind === "partial" || kind === "final") {
          const text =
            typeof parsed.text === "string" ? parsed.text.slice(0, maxTranscriptChars) : "";
          options.onEvent({ sessionId, kind, text });
          if (kind === "final") {
            clearTimeout(session.finalizeTimer);
          }
          return;
        }
        if (kind === "error") {
          options.onEvent({
            sessionId,
            kind: "error",
            code: typeof parsed.code === "string" ? parsed.code : "recognition_failed",
            message:
              typeof parsed.message === "string"
                ? parsed.message.slice(0, 400)
                : "Speech recognition could not complete.",
          });
          return;
        }
        if (kind === "stopped") {
          emitOnceStopped();
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (session.cancelled) return;
        lineBuffer += chunk.toString("utf8");
        if (Buffer.byteLength(lineBuffer) > maxLineBytes) {
          options.onEvent({
            sessionId,
            kind: "error",
            code: "helper_output_overflow",
            message: "Speech helper output exceeded limits.",
          });
          terminate("output_overflow");
          return;
        }
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      child.stderr.on("data", () => {});
      child.stdin.on("error", () => {});
      child.on("error", () => {
        if (!session.cancelled) {
          options.onEvent({
            sessionId,
            kind: "error",
            code: "helper_unavailable",
            message: "Local speech helper is unavailable on this computer.",
          });
        }
        terminate("error");
      });
      child.once("close", () => {
        clearTimeout(session.durationTimer);
        clearTimeout(session.finalizeTimer);
        clearTimeout(session.killTimer);
        if (!session.cancelled && lineBuffer.trim()) {
          handleLine(lineBuffer);
          lineBuffer = "";
        }
        if (active?.id === sessionId) active = undefined;
        emitOnceStopped();
      });

      child.stdin.write(
        `${JSON.stringify({
          op: "stream",
          ...(locale ? { locale } : {}),
          onDevice,
          source,
          ...(contextualStrings.length ? { contextualStrings } : {}),
        })}\n`,
      );
      return { sessionId };
    },

    writeAudio(sessionId: string, pcm16le: Uint8Array): void {
      if (typeof sessionId !== "string" || !active || active.id !== sessionId || active.closing)
        return;
      if (!(pcm16le instanceof Uint8Array) || pcm16le.byteLength === 0) return;
      if (pcm16le.byteLength > maxChunkBytes) throw new Error("audio_chunk_too_large");
      if (active.writtenBytes + pcm16le.byteLength > maxAudioBytes) {
        active.closing = true;
        try {
          active.child.stdin.end();
        } catch {}
        active.finalizeTimer = setTimeout(
          () => active?.terminate("audio_byte_limit"),
          options.finalizeTimeoutMs ?? 1500,
        );
        return;
      }
      active.writtenBytes += pcm16le.byteLength;
      try {
        active.child.stdin.write(
          Buffer.from(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength),
        );
      } catch {}
    },

    async stop(sessionId: string): Promise<void> {
      if (typeof sessionId !== "string" || !active || active.id !== sessionId) return;
      const target = active;
      if (target.closing) return;
      target.closing = true;
      try {
        target.child.stdin.end();
      } catch {}
      await new Promise<void>((resolve) => {
        const checkDone = () => {
          if (target.stoppedEmitted) resolve();
        };
        target.child.once("close", () => resolve());
        target.finalizeTimer = setTimeout(() => {
          target.terminate("stop_timeout");
          resolve();
        }, options.finalizeTimeoutMs ?? 1500);
        checkDone();
      });
    },

    cancel(sessionId?: string): void {
      if (!active) return;
      if (sessionId !== undefined && active.id !== sessionId) return;
      const target = active;
      target.cancelled = true;
      target.closing = true;
      target.terminate("cancelled");
    },
  };
}
