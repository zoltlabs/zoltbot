// O1: Voice settings, opened from the account menu. Engine, voice, speed and whether new replies
// are read aloud. O3 adds the push-to-talk key. ElevenLabs needs the owner's key, which goes to the daemon's keychain.
import { SPEECH_RATES } from "@zoltbot/protocol";
import { createResource, createRoot, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { PushToTalkKey, SpeechEnginePreference } from "../../../../shared/preferences";
import type { VoiceOption } from "../../../../shared/voice";
import { t } from "../../i18n";
import { Dialog, Field, Select, SettingsRow, Stack } from "../../kit";
import { setVoicePreferences, voicePreferences } from "./read-aloud";
import "./voice.css";

const [open, setOpen] = createRoot(() => createSignal(false));
export const openVoiceSettings = () => setOpen(true);

/** Mounted once; shows the dialog while it's open. */
export function VoiceSettingsHost() {
  return (
    <Show when={open()}>
      <VoiceSettings onClose={() => setOpen(false)} />
    </Show>
  );
}

function useSystemVoices() {
  const synth = globalThis.speechSynthesis;
  const [voices, setVoices] = createSignal<SpeechSynthesisVoice[]>(synth?.getVoices() ?? []);
  onMount(() => {
    if (!synth) return;
    const update = () => setVoices(synth.getVoices());
    synth.addEventListener?.("voiceschanged", update);
    onCleanup(() => synth.removeEventListener?.("voiceschanged", update));
  });
  return voices;
}

function VoiceSettings(props: { onClose: () => void }) {
  const prefs = voicePreferences;
  const systemVoices = useSystemVoices();
  const [status, { mutate: setStatus }] = createResource(() =>
    window.openbot.voice.status().catch(() => ({ elevenlabs: false })),
  );
  const [elevenVoices, setElevenVoices] = createSignal<VoiceOption[]>([]);
  const [key, setKey] = createSignal("");
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const eleven = () => prefs().speechEngine === "elevenlabs";
  const keySet = () => status()?.elevenlabs === true;

  const loadElevenVoices = async () => {
    try {
      const voices = await window.openbot.voice.voices();
      setElevenVoices(voices);
      if (voices[0] && !voices.some((v) => v.id === prefs().elevenVoice))
        setVoicePreferences({ elevenVoice: voices[0].id });
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    }
  };
  onMount(() => {
    void window.openbot.voice
      .status()
      .then((value) => {
        if (value.elevenlabs && eleven()) void loadElevenVoices();
      })
      .catch(() => undefined);
  });

  const chooseEngine = (engine: SpeechEnginePreference) => {
    setVoicePreferences({ speechEngine: engine });
    if (engine === "elevenlabs" && keySet() && !elevenVoices().length) void loadElevenVoices();
  };

  const saveKey = async (event: Event) => {
    event.preventDefault();
    if (!key().trim() || busy()) return;
    setBusy(true);
    setKeyError(null);
    try {
      const voices = await window.openbot.voice.setKey(key().trim());
      setKey("");
      setStatus({ elevenlabs: true });
      setElevenVoices(voices);
      if (voices[0] && !voices.some((v) => v.id === prefs().elevenVoice))
        setVoicePreferences({ elevenVoice: voices[0].id });
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await window.openbot.voice.clearKey();
      setStatus({ elevenlabs: false });
      setElevenVoices([]);
      setVoicePreferences({ elevenVoice: "" });
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const voiceOptions = () =>
    eleven()
      ? elevenVoices().map((v) => ({ value: v.id, label: v.name }))
      : [
          { value: "", label: t("voice.systemDefault") },
          ...systemVoices().map((v) => ({ value: v.voiceURI, label: `${v.name} (${v.lang})` })),
        ];

  return (
    <Dialog
      title={t("voice.title")}
      width={460}
      onClose={props.onClose}
      busy={busy()}
      actions={
        <button type="button" class="zb-kit-button primary" onClick={props.onClose}>
          {t("voice.done")}
        </button>
      }
    >
      <Stack gap={3} class="voice-settings">
        <SettingsRow
          label={t("voice.readNew")}
          control={(id) => (
            <input
              id={id}
              type="checkbox"
              role="switch"
              class="voice-switch"
              checked={prefs().readAloud}
              aria-checked={prefs().readAloud}
              onChange={(event) => setVoicePreferences({ readAloud: event.currentTarget.checked })}
            />
          )}
        />
        <SettingsRow
          label={t("voice.engine")}
          control={() => (
            <Select
              label={t("voice.engine")}
              value={prefs().speechEngine}
              options={[
                { value: "system", label: t("voice.thisMac") },
                { value: "elevenlabs", label: t("voice.elevenlabs") },
              ]}
              onChange={chooseEngine}
            />
          )}
        />
        <Show when={eleven() && !keySet()}>
          <form onSubmit={(event) => void saveKey(event)}>
            <Field
              label={t("voice.key")}
              error={keyError()}
              input={(id, describedBy) => (
                <div class="voice-key">
                  <input
                    id={id}
                    class="zb-kit-input"
                    type="password"
                    autocomplete="off"
                    spellcheck={false}
                    maxLength={200}
                    value={key()}
                    aria-invalid={keyError() ? true : undefined}
                    aria-describedby={describedBy}
                    onInput={(event) => setKey(event.currentTarget.value)}
                  />
                  <button type="submit" class="zb-kit-button" disabled={busy() || !key().trim()}>
                    {t("voice.saveKey")}
                  </button>
                </div>
              )}
            />
          </form>
        </Show>
        <Show when={eleven()}>
          <p class="voice-note">{t("voice.sent")}</p>
        </Show>
        <Show when={!eleven() || keySet()}>
          <SettingsRow
            label={t("voice.voice")}
            error={eleven() && keySet() ? keyError() : null}
            control={() => (
              <Select
                label={t("voice.voice")}
                value={eleven() ? prefs().elevenVoice || null : prefs().speechVoice}
                options={voiceOptions()}
                disabled={eleven() && !elevenVoices().length}
                onChange={(value) =>
                  setVoicePreferences(eleven() ? { elevenVoice: value } : { speechVoice: value })
                }
              />
            )}
          />
        </Show>
        <SettingsRow
          label={t("voice.speed")}
          control={() => (
            <Select
              label={t("voice.speed")}
              value={String(prefs().speechRate)}
              options={SPEECH_RATES.map((rate) => ({
                value: String(rate),
                label: t("voice.rate", { rate }),
              }))}
              onChange={(value) => setVoicePreferences({ speechRate: Number(value) })}
            />
          )}
        />
        <SettingsRow
          label={t("voice.pushToTalk")}
          control={() => (
            <Select
              label={t("voice.pushToTalk")}
              value={prefs().pushToTalkKey}
              options={[
                { value: "Fn", label: t("voice.ptt.fn") },
                { value: "AltRight", label: t("voice.ptt.rightOption") },
                { value: "MetaRight", label: t("voice.ptt.rightCommand") },
                { value: "off", label: t("voice.ptt.off") },
              ]}
              onChange={(value) => setVoicePreferences({ pushToTalkKey: value as PushToTalkKey })}
            />
          )}
        />
        <Show when={prefs().pushToTalkKey !== "off"}>
          <SettingsRow
            label={t("voice.sendOnRelease")}
            control={(id) => (
              <input
                id={id}
                type="checkbox"
                role="switch"
                class="voice-switch"
                checked={prefs().sendOnRelease}
                aria-checked={prefs().sendOnRelease}
                onChange={(event) =>
                  setVoicePreferences({ sendOnRelease: event.currentTarget.checked })
                }
              />
            )}
          />
        </Show>
        <Show when={eleven() && keySet()}>
          <div>
            <button
              type="button"
              class="zb-kit-button"
              disabled={busy()}
              onClick={() => void removeKey()}
            >
              {t("voice.removeKey")}
            </button>
          </div>
        </Show>
      </Stack>
    </Dialog>
  );
}
