// O1 and O5: ElevenLabs on the owner's own key, as the optional engine for reading replies aloud.
// The key lives in the keychain (I7); the settings row holds only its reference. Both the Mac and
// the phone ask the daemon for audio, so the key never leaves this Mac's daemon. O2 logs calls.
import {
  chatCallsKey,
  type DomainEvent,
  SPEECH_REQUEST_CHARS,
  VOICE_ELEVENLABS_SETTING,
  withCall,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateVault } from "./private-context.js";

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_multilingual_v2";
/** One request's audio; its base64 still fits a relay frame for the phone. */
const MAX_AUDIO = 560 * 1024;
const MAX_VOICES = 200;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VoiceHost {
  store: Store;
  vault?: PrivateVault;
  publish(events: DomainEvent[]): void;
  /** Keeps the key out of logs. */
  register(value: string): void;
  /** True when text holds a known private value; such text isn't sent out. */
  containsSecret(text: string): Promise<boolean>;
  fetch?: Fetch;
}

interface Voice {
  id: string;
  name: string;
}

function storedReference(store: Store): string | undefined {
  const value = store
    .snapshot(["settings"])
    .settings?.find((row) => row.key === VOICE_ELEVENLABS_SETTING)?.value as
    | { reference?: unknown }
    | undefined;
  return typeof value?.reference === "string" ? value.reference : undefined;
}

type Snapshot = ReturnType<Store["snapshot"]>;

function writeSetting(
  host: VoiceHost,
  commandId: string,
  key: string,
  value: (snapshot: Snapshot) => unknown,
) {
  const before = host.store.lastSeq();
  host.store.dispatch(
    commandId,
    (snapshot) => {
      const at = new Date().toISOString();
      return {
        events: [
          {
            eventId: `${commandId}:0`,
            aggregateType: "settings",
            aggregateId: key,
            type: "settings.created",
            occurredAt: at,
            payload: { key, value: value(snapshot) },
          },
        ],
        result: undefined,
      };
    },
    { items: { ids: [] } },
  );
  host.publish(host.store.eventsSince(before));
}

async function request(host: VoiceHost, key: string, path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await (host.fetch ?? fetch)(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), "xi-api-key": key },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("voice_unreachable");
  }
  if (response.status === 401 || response.status === 403) throw new Error("voice_key_rejected");
  if (response.status === 429) throw new Error("voice_limit");
  if (!response.ok) throw new Error("voice_unreachable");
  return response;
}

async function listVoices(host: VoiceHost, key: string): Promise<Voice[]> {
  const body = (await (await request(host, key, "/voices")).json().catch(() => null)) as {
    voices?: { voice_id?: unknown; name?: unknown }[];
  } | null;
  return (body?.voices ?? [])
    .filter((v) => typeof v.voice_id === "string" && /^[A-Za-z0-9]{1,64}$/.test(v.voice_id))
    .slice(0, MAX_VOICES)
    .map((v) => ({
      id: v.voice_id as string,
      name: typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 80) : "Voice",
    }));
}

/** Reads a body up to `max` bytes, failing past it. */
async function capped(response: Response, max: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > max) throw new Error("voice_unreachable");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("voice_unreachable");
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("voice_unreachable");
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

export function voiceApi(host: VoiceHost) {
  const key = async (): Promise<string> => {
    const reference = storedReference(host.store);
    if (!reference || !host.vault) throw new Error("voice_not_set_up");
    const value = await host.vault.read(reference).catch(() => undefined);
    const stored = (value as { key?: unknown } | undefined)?.key;
    if (typeof stored !== "string" || !stored) throw new Error("voice_not_set_up");
    host.register(stored);
    return stored;
  };

  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    switch (method) {
      case "voice.status":
        return { elevenlabs: Boolean(host.vault && storedReference(host.store)) };
      case "voice.voices":
        return { voices: await listVoices(host, await key()) };
      case "voice.key.set": {
        if (!commandId) throw new Error("command_id_required");
        if (!host.vault) throw new Error("keychain_unavailable");
        const value = String(params.key ?? "").trim();
        if (!/^[\x21-\x7e]{8,200}$/.test(value)) throw new Error("voice_key_rejected");
        // A key ElevenLabs refuses is never stored.
        const voices = await listVoices(host, value);
        host.register(value);
        // A repeated command already stored its key; storing again would orphan one.
        if (host.store.receipt(commandId)) return { voices };
        const old = storedReference(host.store);
        const { reference } = await host.vault.put({ key: value });
        writeSetting(host, commandId, VOICE_ELEVENLABS_SETTING, () => ({ reference }));
        if (old && old !== reference) await host.vault.remove?.(old).catch(() => undefined);
        return { voices };
      }
      case "voice.key.clear": {
        if (!commandId) throw new Error("command_id_required");
        if (host.store.receipt(commandId)) return {};
        const old = storedReference(host.store);
        writeSetting(host, commandId, VOICE_ELEVENLABS_SETTING, () => ({}));
        if (old) await host.vault?.remove?.(old).catch(() => undefined);
        return {};
      }
      case "voice.speak": {
        const text = String(params.text ?? "").trim();
        const voiceId = String(params.voiceId ?? "");
        if (!text || text.length > SPEECH_REQUEST_CHARS) throw new Error("voice_text_invalid");
        if (!/^[A-Za-z0-9]{1,64}$/.test(voiceId)) throw new Error("voice_not_found");
        if (await host.containsSecret(text)) throw new Error("private_value");
        const response = await request(
          host,
          await key(),
          `/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text, model_id: MODEL }),
          },
        );
        const audio = await capped(response, MAX_AUDIO);
        return { mime: "audio/mpeg", data: audio.toString("base64") };
      }
      case "voice.call.log": {
        // O2: a finished call, shown in its chat as "Call · 2:15".
        if (!commandId) throw new Error("command_id_required");
        const threadId = String(params.threadId ?? "");
        const startedAt = String(params.startedAt ?? "");
        const endedAt = String(params.endedAt ?? "");
        const start = Date.parse(startedAt);
        const end = Date.parse(endedAt);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
          throw new Error("call_time_invalid");
        if (host.store.receipt(commandId)) return {};
        writeSetting(host, commandId, chatCallsKey(threadId), (snapshot) => {
          if (!snapshot.thread?.some((row) => row.id === threadId))
            throw new Error("thread_not_found");
          const key = chatCallsKey(threadId);
          return withCall(snapshot.settings?.find((row) => row.key === key)?.value, {
            id: commandId,
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(end).toISOString(),
          });
        });
        return {};
      }
      default:
        return undefined;
    }
  };
}
