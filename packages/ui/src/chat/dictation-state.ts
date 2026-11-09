export type DictationMode = "hold" | "toggle";
export type DictationShortcut = "alt+space" | "mod+shift+d" | "off";

export interface DictationSettings {
  mode: DictationMode;
  shortcut: DictationShortcut;
  locale: string;
  onDevice: boolean;
}

const storageKey = "zoltbot.dictation.v1";

export const defaultDictationSettings: DictationSettings = {
  mode: "hold",
  shortcut: "alt+space",
  locale: "en-US",
  onDevice: true,
};

export const supportedDictationLocales = [
  { value: "en-US", label: "English (US)" },
  { value: "en-GB", label: "English (UK)" },
  { value: "es-ES", label: "Spanish" },
  { value: "fr-FR", label: "French" },
  { value: "de-DE", label: "German" },
  { value: "ja-JP", label: "Japanese" },
] as const;

const settingsListeners = new Set<() => void>();

export function readDictationSettings(): DictationSettings {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return defaultDictationSettings;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode: DictationMode = parsed.mode === "toggle" ? "toggle" : "hold";
    const shortcut: DictationShortcut =
      parsed.shortcut === "mod+shift+d" || parsed.shortcut === "off"
        ? parsed.shortcut
        : "alt+space";
    const locale =
      typeof parsed.locale === "string" &&
      /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(parsed.locale)
        ? parsed.locale
        : defaultDictationSettings.locale;
    const onDevice = parsed.onDevice !== false;
    return { mode, shortcut, locale, onDevice };
  } catch {
    return defaultDictationSettings;
  }
}

export function saveDictationSettings(patch: Partial<DictationSettings>): DictationSettings {
  const next: DictationSettings = {
    ...readDictationSettings(),
    ...patch,
  };
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {}
  for (const listener of settingsListeners) listener();
  return next;
}

export function subscribeDictationSettings(listener: () => void): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

export interface DictationAnchor {
  prefix: string;
  suffix: string;
  initialDraft: string;
  initialCursor: number;
}

export function captureDictationAnchor(
  draft: string,
  selectionStart?: number | null,
  selectionEnd?: number | null,
): DictationAnchor {
  const start = Math.max(0, Math.min(draft.length, selectionStart ?? draft.length));
  const end = Math.max(start, Math.min(draft.length, selectionEnd ?? start));
  return {
    prefix: draft.slice(0, start),
    suffix: draft.slice(end),
    initialDraft: draft,
    initialCursor: start,
  };
}

export function applyDictationTranscript(
  anchor: DictationAnchor,
  rawTranscript: string,
): { draft: string; cursor: number } {
  const transcript = rawTranscript.replace(/\r\n/g, "\n").trim();
  if (!transcript) {
    return {
      draft: `${anchor.prefix}${anchor.suffix}`,
      cursor: anchor.prefix.length,
    };
  }
  const lead =
    anchor.prefix.length > 0 && !/\s$/.test(anchor.prefix) && !/^[,.;:!?)]/.test(transcript)
      ? " "
      : "";
  const trail =
    anchor.suffix.length > 0 && !/^\s/.test(anchor.suffix) && !/^[,.;:!?)]/.test(anchor.suffix)
      ? " "
      : "";
  const inserted = `${lead}${transcript}`;
  return {
    draft: `${anchor.prefix}${inserted}${trail}${anchor.suffix}`,
    cursor: anchor.prefix.length + inserted.length,
  };
}

export function rollbackDictationAnchor(anchor: DictationAnchor): {
  draft: string;
  cursor: number;
} {
  return {
    draft: anchor.initialDraft,
    cursor: anchor.initialCursor,
  };
}

export function matchesDictationShortcut(
  event: {
    key: string;
    code?: string;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
  },
  shortcut: DictationShortcut,
): boolean {
  if (shortcut === "off") return false;
  if (shortcut === "alt+space") {
    return Boolean(
      event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        (event.code === "Space" || event.key === " " || event.key === "\u00a0"),
    );
  }
  return Boolean(
    (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      !event.altKey &&
      (event.code === "KeyD" || event.key.toLowerCase() === "d"),
  );
}

export function formatDictationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function shortcutLabel(shortcut: DictationShortcut): string {
  if (shortcut === "alt+space") return "Option + Space";
  if (shortcut === "mod+shift+d") return "Cmd + Shift + D";
  return "Button only";
}

export function collectContextualStrings(input: {
  projectName?: string;
  profileName?: string;
  commands?: readonly { name: string }[];
  extra?: readonly string[];
}): string[] {
  const candidates = [
    input.projectName ?? "",
    input.profileName ?? "",
    ...(input.commands ?? []).map((command) => command.name),
    ...(input.extra ?? []),
  ];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of candidates) {
    const cleaned = raw.replace(/\p{Cc}/gu, "").trim();
    if (
      cleaned.length < 2 ||
      cleaned.length > 80 ||
      /[=:\\]/.test(cleaned) ||
      /^(?:sk-|ghp_|xox[baprs]-|AIza|Bearer\s)/i.test(cleaned) ||
      seen.has(cleaned)
    )
      continue;
    seen.add(cleaned);
    output.push(cleaned);
    if (output.length >= 100) break;
  }
  return output;
}
