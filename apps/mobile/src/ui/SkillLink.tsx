// M5: add a skill from a GitHub link. The Mac fetches it; the owner reviews the files, then installs.
import { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { sans, touch, useTheme } from "../theme";
import { Button, Card, Txt } from "./kit";

interface Preview {
  previewId: string;
  commit: string;
  source: string;
  bundle: { hash: string; name?: string; files: { path: string; content?: string }[] };
}

/** Why a link was refused, in the owner's words; the daemon's sentence after its code. */
export function skillLinkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/offline|not connected|did not answer/i.test(message)) return "Your Mac is offline.";
  const sentence = /skill_[a-z_]+: (.+)$/.exec(message)?.[1];
  return sentence
    ? sentence.charAt(0).toUpperCase() + sentence.slice(1)
    : "Couldn’t read this link.";
}

export function SkillLink(props: {
  disabled: boolean;
  run: (method: string, params: unknown) => Promise<unknown>;
  onInstalled: () => void;
}) {
  const { c } = useTheme();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [added, setAdded] = useState("");
  // A ref, not state: a quick second tap arrives before the re-render that disables the button.
  const busy = useRef(false);

  const attempt = async (work: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setAdded("");
    setWorking(true);
    try {
      await work();
    } catch (cause) {
      setError(skillLinkError(cause));
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  const look = () =>
    attempt(async () => {
      setPreview((await props.run("skill.import.link", { url: url.trim() })) as Preview);
    });
  const install = (current: Preview) =>
    attempt(async () => {
      await props.run("skill.import.link.apply", {
        previewId: current.previewId,
        hash: current.bundle.hash,
      });
      setPreview(undefined);
      setUrl("");
      setAdded(`Added ${current.bundle.name ?? "the skill"}.`);
      props.onInstalled();
    });

  const locked = props.disabled || working;
  return (
    <View style={styles.box}>
      <TextInput
        value={url}
        onChangeText={(next) => {
          setUrl(next);
          setPreview(undefined);
          setAdded("");
        }}
        editable={!locked}
        placeholder="https://github.com/owner/repo/tree/main/skills/name"
        placeholderTextColor={c["text-muted"]}
        accessibilityLabel="GitHub link"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={[
          styles.input,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
        ]}
      />
      {preview ? (
        <Card>
          <Txt v="bodyMedium">{preview.bundle.name ?? preview.source}</Txt>
          <Txt tone="secondary" v="meta">
            {`Commit ${preview.commit.slice(0, 7)} · ${preview.bundle.files.length} ${
              preview.bundle.files.length === 1 ? "file" : "files"
            }`}
          </Txt>
          {preview.bundle.files.slice(0, 20).map((file) => (
            <Txt key={file.path} tone="secondary" v="meta">
              {file.path}
            </Txt>
          ))}
          {preview.bundle.files.length > 20 ? (
            <Txt tone="secondary" v="meta">{`${preview.bundle.files.length - 20} more`}</Txt>
          ) : null}
          {instructions(preview) ? <Txt lines={12}>{instructions(preview)}</Txt> : null}
          <Button
            label="Install"
            kind="primary"
            disabled={locked}
            onPress={() => void install(preview)}
          />
        </Card>
      ) : (
        <Button label="Preview" disabled={locked || !url.trim()} onPress={() => void look()} />
      )}
      {added ? (
        <View accessibilityLiveRegion="polite">
          <Txt tone="secondary">{added}</Txt>
        </View>
      ) : null}
      {error ? (
        <View accessibilityLiveRegion="assertive">
          <Txt tone="danger">{error}</Txt>
        </View>
      ) : null}
    </View>
  );
}

/** What the agent will be told: SKILL.md without its front matter. */
function instructions(preview: Preview) {
  const text = preview.bundle.files.find((file) => file.path === "SKILL.md")?.content ?? "";
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  input: {
    fontFamily: sans,
    minHeight: touch,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
  },
});
