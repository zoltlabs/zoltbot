// O5: Settings › Voice on the phone. ElevenLabs shows only when the Mac has a key for it.
import { useEffect, useState } from "react";
import { useClient, useLink } from "../state/link";
import { PHONE_SPEECH_RATES, type PhoneSpeechEngine, useVoicePrefs } from "../state/voice-prefs";
import { Group, Row, Section, Segmented, Txt } from "./kit";
import { pick } from "./SessionControls";
import { Toggle } from "./Toggle";

type Voice = { id: string; name: string };

export function VoiceSettings() {
  const prefs = useVoicePrefs();
  const online = useClient((state) => state.status) === "online";
  const [eleven, setEleven] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  useEffect(() => {
    if (!online) return;
    let live = true;
    const client = useLink.getState().client?.getState();
    void client
      ?.call("voice.status", {})
      .then(async (status) => {
        const ready = (status as { elevenlabs?: boolean }).elevenlabs === true;
        if (live) setEleven(ready);
        if (!ready) return;
        const answer = (await client.call("voice.voices", {})) as { voices?: Voice[] };
        if (live) setVoices(answer.voices ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [online]);
  const engine: PhoneSpeechEngine = eleven ? prefs.engine : "phone";
  const voice = voices.find((one) => one.id === prefs.voiceId);
  const chooseVoice = () =>
    pick(
      "Voice",
      undefined,
      // The voice in use is marked.
      voices.map((one) => (one.id === prefs.voiceId ? `${one.name} ✓` : one.name)),
      (index) => {
        const chosen = voices[index];
        if (chosen) prefs.set({ voiceId: chosen.id });
      },
    );
  return (
    <>
      <Section title="Voice" />
      <Group>
        <Toggle
          label="Read new replies aloud"
          value={prefs.readNew}
          onChange={(readNew) => prefs.set({ readNew })}
          last
        />
      </Group>
      <Segmented<string>
        label="Speed"
        value={String(prefs.rate)}
        onChange={(rate) => prefs.set({ rate: Number(rate) })}
        options={PHONE_SPEECH_RATES.map((rate) => ({ value: String(rate), label: `${rate}×` }))}
      />
      {eleven ? (
        <>
          <Segmented<PhoneSpeechEngine>
            label="Engine"
            value={engine}
            onChange={(next) => prefs.set({ engine: next })}
            options={[
              { value: "phone", label: "This iPhone" },
              { value: "elevenlabs", label: "ElevenLabs" },
            ]}
          />
          {engine === "elevenlabs" ? (
            <>
              {/* Shown once the Mac has listed the key's voices. */}
              {voices.length ? (
                <Group>
                  <Row title="Voice" detail={voice?.name ?? "Choose"} onPress={chooseVoice} last />
                </Group>
              ) : null}
              <Txt v="meta" tone="muted">
                Messages are sent to ElevenLabs.
              </Txt>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
