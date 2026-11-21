// O1: the ElevenLabs engine over IPC. The key goes to the daemon's keychain; audio comes back
// one piece at a time. The renderer never reads the key back.

export const VOICE_CHANNELS = {
  voiceStatus: "voice:status",
  voiceSetKey: "voice:set-key",
  voiceClearKey: "voice:clear-key",
  voiceVoices: "voice:voices",
  voiceSpeak: "voice:speak",
} as const;

export interface VoiceOption {
  id: string;
  name: string;
}

export interface VoiceDesktopApi {
  /** Whether an ElevenLabs key is set up. */
  status: () => Promise<{ elevenlabs: boolean }>;
  /** Checks and saves the key, returning its voices. Throws a message to show. */
  setKey: (key: string) => Promise<VoiceOption[]>;
  clearKey: () => Promise<void>;
  voices: () => Promise<VoiceOption[]>;
  /** One piece of text as MP3 bytes. Throws a message to show. */
  speak: (input: { text: string; voiceId: string }) => Promise<Uint8Array>;
}
