import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DictationControl, useDictation } from "../chat/Dictation.js";
import {
  type DictationMode,
  type DictationSettings,
  type DictationShortcut,
  readDictationSettings,
  saveDictationSettings,
  subscribeDictationSettings,
  supportedDictationLocales,
} from "../chat/dictation-state.js";
import { Button } from "../components/primitives.js";
import type { DesktopDictationStatus } from "../connection.js";

function formatReadiness(status: DesktopDictationStatus | null): string {
  if (!window.zoltDesktop?.dictation) {
    return "Unavailable in browser mode · Open the desktop app to use local dictation.";
  }
  if (!status) return "Checking local speech recognition…";
  if (status.microphone === "denied" || status.speech === "denied") {
    return "Permission needed · Grant Microphone and Speech Recognition access in macOS Settings.";
  }
  if (!status.available) {
    return `Speech recognizer unavailable for ${status.locale}`;
  }
  const engine = status.onDevice ? "On-device recognition" : "macOS recognition";
  return `Ready · ${engine} (${status.locale}) · Microphone ${status.microphone.replaceAll("_", " ")}`;
}

export function VoiceSettings() {
  const id = useId();
  const [settings, setSettings] = useState<DictationSettings>(() => readDictationSettings());
  const [status, setStatus] = useState<DesktopDictationStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [practice, setPractice] = useState("");
  const [error, setError] = useState("");
  const practiceEditor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => subscribeDictationSettings(() => setSettings(readDictationSettings())), []);

  const refreshStatus = useCallback(async (locale: string) => {
    const bridge = window.zoltDesktop?.dictation;
    if (!bridge) return;
    try {
      const next = await bridge.status({ locale });
      setStatus(next);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus(settings.locale);
  }, [refreshStatus, settings.locale]);

  const practiceDictation = useDictation({
    scopeKey: `voice-settings-practice-${id}`,
    draft: practice,
    editorRef: practiceEditor,
    onUpdateDraft: (nextDraft) => setPractice(nextDraft),
    onError: setError,
  });

  const update = (patch: Partial<DictationSettings>) => {
    const next = saveDictationSettings(patch);
    setSettings(next);
  };

  return (
    <section className="zb-card settings-panel" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>Voice and dictation</h2>
      <p className="settings-hint">
        Hold a key or press Dictate, speak, edit the transcript, and send it as an ordinary message.
        Audio stays on this computer and adds zero context tokens.
      </p>
      <output aria-label="Dictation readiness">{formatReadiness(status)}</output>
      {window.zoltDesktop?.dictation ? (
        <div className="r wrap">
          <Button
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setError("");
              try {
                const next = await window.zoltDesktop?.dictation?.requestPermission({
                  locale: settings.locale,
                });
                if (next) setStatus(next);
              } catch {
                setError("Could not check microphone access.");
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? "Checking…" : "Check microphone access"}
          </Button>
        </div>
      ) : null}
      <div className="settings-field">
        <label htmlFor={`${id}-mode`}>Dictation mode</label>
        <select
          id={`${id}-mode`}
          value={settings.mode}
          onChange={(event) => update({ mode: event.target.value as DictationMode })}
        >
          <option value="hold">Hold to talk</option>
          <option value="toggle">Press to toggle</option>
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor={`${id}-shortcut`}>Dictation shortcut</label>
        <select
          id={`${id}-shortcut`}
          value={settings.shortcut}
          onChange={(event) => update({ shortcut: event.target.value as DictationShortcut })}
        >
          <option value="alt+space">Option + Space</option>
          <option value="mod+shift+d">Cmd + Shift + D</option>
          <option value="off">Button only</option>
        </select>
      </div>
      <div className="settings-field">
        <label htmlFor={`${id}-locale`}>Dictation language</label>
        <select
          id={`${id}-locale`}
          value={settings.locale}
          onChange={(event) => update({ locale: event.target.value })}
        >
          {supportedDictationLocales.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      <label>
        <input
          type="checkbox"
          checked={settings.onDevice}
          onChange={(event) => update({ onDevice: event.target.checked })}
        />{" "}
        Prefer on-device offline recognition
      </label>
      <div className="r wrap">
        <label htmlFor={`${id}-practice`}>Practice dictation</label>
        <span className="sp" />
        <DictationControl dictation={practiceDictation} label="Test dictation" />
        {practice ? (
          <Button size="sm" onClick={() => setPractice("")}>
            Clear
          </Button>
        ) : null}
      </div>
      <textarea
        ref={practiceEditor}
        id={`${id}-practice`}
        rows={2}
        value={practice}
        placeholder="Hold Option + Space or click Test dictation to try your microphone here."
        onKeyDown={(event) => {
          practiceDictation.handleKeyDown(event);
        }}
        onKeyUp={(event) => {
          practiceDictation.handleKeyUp(event);
        }}
        onChange={(event) => setPractice(event.target.value)}
      />
      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
