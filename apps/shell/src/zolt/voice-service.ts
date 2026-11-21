// O1: IPC handlers for ElevenLabs. The daemon holds the key and calls the service.
import { randomUUID } from "node:crypto";
import { VOICE_CHANNELS as C, type VoiceOption } from "../shared/voice";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "call">;

const MESSAGES: Record<string, string> = {
  voice_key_rejected: "ElevenLabs didn’t accept this key.",
  voice_limit: "ElevenLabs is out of credits or busy. Try again later.",
  voice_unreachable: "Couldn’t reach ElevenLabs.",
  voice_not_set_up: "Add your ElevenLabs key in Voice settings.",
  voice_not_found: "Pick a voice in Voice settings.",
  keychain_unavailable: "Couldn’t save the key in the keychain.",
  private_value: "This message holds a private value, so it wasn’t sent to ElevenLabs.",
};

/** The daemon's error code as a sentence to show. */
export function voiceError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const code = Object.keys(MESSAGES).find((key) => raw.includes(key));
  return new Error(code ? MESSAGES[code] : "Couldn’t read this aloud.");
}

function voices(value: unknown): VoiceOption[] {
  const list = isObject(value) && Array.isArray(value.voices) ? value.voices : [];
  return list
    .filter(
      (v): v is VoiceOption =>
        isObject(v) && typeof v.id === "string" && typeof v.name === "string",
    )
    .map((v) => ({ id: v.id, name: v.name }));
}

export function voiceHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  const call = async (method: string, params: Record<string, unknown>) => {
    try {
      return await client.call(method, params, randomUUID());
    } catch (error) {
      throw voiceError(error);
    }
  };
  return {
    [C.voiceStatus]: async () => {
      const value = await call("voice.status", {});
      return { elevenlabs: isObject(value) && value.elevenlabs === true };
    },
    [C.voiceSetKey]: async (input) =>
      voices(await call("voice.key.set", { key: requireString(input, "key") })),
    [C.voiceClearKey]: async () => {
      await call("voice.key.clear", {});
    },
    [C.voiceVoices]: async () => voices(await call("voice.voices", {})),
    [C.voiceSpeak]: async (input) => {
      if (!isObject(input)) throw new Error("Couldn’t read this aloud.");
      const value = await call("voice.speak", {
        text: requireString(input.text, "text"),
        voiceId: requireString(input.voiceId, "voiceId"),
      });
      if (!isObject(value) || typeof value.data !== "string") throw voiceError("");
      return new Uint8Array(Buffer.from(value.data, "base64"));
    },
    [C.voiceCallLog]: async (input) => {
      if (!isObject(input)) throw new Error("Invalid call.");
      await client.call(
        "voice.call.log",
        {
          threadId: requireString(input.botId, "botId"),
          startedAt: requireString(input.startedAt, "startedAt"),
          endedAt: requireString(input.endedAt, "endedAt"),
        },
        randomUUID(),
      );
    },
  };
}
