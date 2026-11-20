// S10: an artifact's published link (Share link opens the system share sheet, which can copy
// it) and Add to the repository, on the phone's artifact screen. Publishing happens on the Mac.
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Platform, Share, StyleSheet, View } from "react-native";
import { type ArtifactActionsView, repositoryError, STILL_HELD } from "../data/artifact-actions";
import { newId } from "../state/actions";
import { useClient, useLink } from "../state/link";
import { Button, Card, showConfirmSheet, Txt } from "./kit";

export function ArtifactActions({ view }: { view: ArtifactActionsView }) {
  const online = useClient((state) => state.status === "online");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const line = view.repository?.line ?? "";
  // Keep the buttons off until the snapshot shows the new state, so a second tap can't slip in.
  const waiting = useRef<string | null>(null);
  useEffect(() => {
    if (waiting.current !== null && waiting.current !== line) {
      waiting.current = null;
      setBusy(false);
      if (line) AccessibilityInfo.announceForAccessibility(line);
    }
  }, [line]);

  function fail(message: string) {
    waiting.current = null;
    running.current = false;
    setBusy(false);
    setError(message);
    AccessibilityInfo.announceForAccessibility(message);
  }

  async function add(allowHeld: boolean) {
    const client = useLink.getState().client?.getState();
    if (!client || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const result = (await client.call(
        "artifact.add_to_repository",
        { id: view.artifactId, versionId: view.versionId, allowHeld },
        newId("phone"),
      )) as { held?: boolean } | null;
      if (allowHeld && result?.held) return fail(STILL_HELD);
      running.current = false;
      waiting.current = line;
      setTimeout(() => {
        if (waiting.current === null) return;
        waiting.current = null;
        setBusy(false);
      }, 3000);
    } catch (failure) {
      fail(repositoryError(failure));
    }
  }

  const url = view.link?.url;
  const linkLine = view.link
    ? `${view.link.visibility === "public" ? "Public link" : "Private link"}${
        view.link.current ? "" : " · shows an older version"
      }`
    : "Not published";

  return (
    <Card>
      <Txt v="cardTitle">{view.title}</Txt>
      <Txt tone="secondary">{linkLine}</Txt>
      {url ? (
        <Button
          label="Share link"
          a11y={`Share link for ${view.title}`}
          onPress={() => void Share.share(Platform.OS === "ios" ? { url } : { message: url })}
        />
      ) : null}
      {view.repository ? (
        <View style={styles.repository}>
          {line ? <Txt tone="secondary">{line}</Txt> : null}
          {!online && (view.repository.canAdd || view.repository.held) ? (
            <Txt tone="secondary">Saving needs a connection to the Mac.</Txt>
          ) : null}
          {view.repository.canAdd ? (
            <Button
              label={busy ? "Saving…" : "Add to the repository"}
              a11y={`Add ${view.title} to the repository`}
              disabled={!online || busy}
              onPress={() => void add(false)}
            />
          ) : null}
          {view.repository.held ? (
            <Button
              label="Save anyway"
              a11y={`Save ${view.title} anyway`}
              disabled={!online || busy}
              onPress={() =>
                showConfirmSheet({
                  title: "Save anyway?",
                  body: "This version may contain a secret. Its files will be written into your project’s repository.",
                  confirmLabel: "Save anyway",
                  onConfirm: () => void add(true),
                })
              }
            />
          ) : null}
        </View>
      ) : null}
      {error ? (
        <View accessibilityLiveRegion="polite">
          <Txt tone="danger">{error}</Txt>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  repository: { gap: 8 },
});
