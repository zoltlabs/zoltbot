import { VOICE_ELEVENLABS_SETTING } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { voiceApi } from "./voice-api.js";

const KEY = "sk_test_voice_key_123";

function vault() {
  const values = new Map<string, unknown>();
  let next = 0;
  return {
    values,
    put: vi.fn(async (value: unknown) => {
      const reference = `keychain:zoltbot:00000000-0000-4000-8000-00000000000${next++}`;
      values.set(reference, value);
      return { reference };
    }),
    read: vi.fn(async (reference: string) => values.get(reference)),
    remove: vi.fn(async (reference: string) => void values.delete(reference)),
  };
}

function eleven(options: { key?: string; audio?: Uint8Array } = {}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    if (headers["xi-api-key"] !== (options.key ?? KEY)) return new Response("no", { status: 401 });
    if (url.endsWith("/voices"))
      return Response.json({
        voices: [
          { voice_id: "abc123", name: "Ava" },
          { voice_id: "../bad", name: "Bad" },
        ],
      });
    if (url.includes("/text-to-speech/abc123"))
      return new Response((options.audio ?? new Uint8Array([1, 2, 3])) as unknown as BodyInit, {
        headers: { "Content-Type": "audio/mpeg" },
      });
    return new Response("missing", { status: 404 });
  });
}

async function fixture(fetch = eleven(), secrets = vault()) {
  const f = await forkFixture();
  const registered: string[] = [];
  const api = voiceApi({
    store: f.store,
    vault: secrets,
    publish: () => undefined,
    register: (value) => registered.push(value),
    containsSecret: async (text) => text.includes("PRIVATE"),
    fetch,
  });
  const setting = () =>
    f.store.snapshot(["settings"]).settings?.find((r) => r.key === VOICE_ELEVENLABS_SETTING)?.value;
  return { ...f, api, setting, secrets, registered, fetch };
}

it("keeps a checked key in the keychain and only its reference in settings", async () => {
  const f = await fixture();
  try {
    expect(await f.api("voice.status", {})).toEqual({ elevenlabs: false });
    await expect(f.api("voice.voices", {})).rejects.toThrow("voice_not_set_up");
    expect(await f.api("voice.key.set", { key: KEY }, "set-1")).toEqual({
      voices: [{ id: "abc123", name: "Ava" }],
    });
    const stored = f.setting() as { reference: string };
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(f.secrets.values.get(stored.reference)).toEqual({ key: KEY });
    expect(f.registered).toContain(KEY);
    expect(await f.api("voice.status", {})).toEqual({ elevenlabs: true });
    // A replayed command keeps the stored key.
    await f.api("voice.key.set", { key: KEY }, "set-1");
    expect(f.secrets.values.get((f.setting() as { reference: string }).reference)).toEqual({
      key: KEY,
    });
    expect(f.secrets.values.size).toBe(1);
    await f.api("voice.key.clear", {}, "clear-1");
    expect(f.setting()).toEqual({});
    expect(f.secrets.values.size).toBe(0);
  } finally {
    f.close();
  }
});

it("never stores a key ElevenLabs refuses", async () => {
  const f = await fixture(eleven({ key: "another_key_value" }));
  try {
    await expect(f.api("voice.key.set", { key: KEY }, "set-1")).rejects.toThrow(
      "voice_key_rejected",
    );
    await expect(f.api("voice.key.set", { key: "short" }, "set-2")).rejects.toThrow(
      "voice_key_rejected",
    );
    expect(f.secrets.put).not.toHaveBeenCalled();
    expect(f.setting()).toBeUndefined();
  } finally {
    f.close();
  }
});

it("speaks a piece as MP3, and refuses private text, unknown voices and oversized audio", async () => {
  const f = await fixture();
  try {
    await f.api("voice.key.set", { key: KEY }, "set-1");
    expect(await f.api("voice.speak", { text: "Hello there.", voiceId: "abc123" })).toEqual({
      mime: "audio/mpeg",
      data: Buffer.from([1, 2, 3]).toString("base64"),
    });
    const body = JSON.parse(String(f.fetch.mock.calls.at(-1)?.[1].body));
    expect(body.text).toBe("Hello there.");
    const calls = f.fetch.mock.calls.length;
    await expect(
      f.api("voice.speak", { text: "the PRIVATE value", voiceId: "abc123" }),
    ).rejects.toThrow("private_value");
    await expect(f.api("voice.speak", { text: "Hi", voiceId: "../x" })).rejects.toThrow(
      "voice_not_found",
    );
    expect(f.fetch.mock.calls.length).toBe(calls);
  } finally {
    f.close();
  }
  const big = await fixture(eleven({ audio: new Uint8Array(600 * 1024) }));
  try {
    await big.api("voice.key.set", { key: KEY }, "set-1");
    await expect(big.api("voice.speak", { text: "Hi", voiceId: "abc123" })).rejects.toThrow(
      "voice_unreachable",
    );
  } finally {
    big.close();
  }
});
