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
  /** `microphone` lets the speech helper record; `pcm16le` expects `sendAudio` chunks. */
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

export interface DictationDesktopApi {
  status: (params?: { locale?: string }) => Promise<DictationStatus>;
  requestPermission: (params?: { locale?: string }) => Promise<DictationStatus>;
  start: (options?: DictationStartOptions) => Promise<{ sessionId: string }>;
  /** 16 kHz mono 16-bit little-endian PCM, at most 64 KiB per chunk. */
  sendAudio: (sessionId: string, pcm16le: Uint8Array) => void;
  stop: (sessionId: string) => Promise<void>;
  cancel: (sessionId?: string) => Promise<void>;
  onEvent: (listener: (event: DictationEvent) => void) => () => void;
}
