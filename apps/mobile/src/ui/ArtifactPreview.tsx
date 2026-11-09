import { useEffect, useState } from "react";
import { Image, View } from "react-native";
import { useClient, useLink } from "../state/link";
import { Button, Txt } from "./kit";
import { Markdown } from "./Markdown";

type Preview =
  | { kind: "text"; text: string }
  | { kind: "image"; uri: string; width: number; height: number };
export function ArtifactPreview({
  artifactId,
  versionId,
  label,
}: {
  artifactId: string;
  versionId: string;
  label: string;
}) {
  const online = useClient((s) => s.status === "online");
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // A retry explicitly reloads the immutable version.
    void attempt;
    let live = true;
    setPreview(undefined);
    setError("");
    const client = useLink.getState().client;
    if (!online || !client) return;
    client
      .getState()
      .call("artifact.phonePreview", { id: artifactId, versionId })
      .then((data) => {
        const p = data as Preview;
        if (!p || (p.kind !== "text" && p.kind !== "image")) throw Error("preview_unavailable");
        if (p.kind === "image" && !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.uri))
          throw Error("preview_unavailable");
        if (live) setPreview(p);
      })
      .catch(() => {
        if (live)
          setError(
            "Preview unavailable. Check that your Mac has browser support installed, or open this version on your Mac.",
          );
      });
    return () => {
      live = false;
    };
  }, [artifactId, versionId, online, attempt]);
  return (
    <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
      {!online ? (
        <Txt>Reconnect to your Mac to load this version.</Txt>
      ) : error ? (
        <>
          <Txt>{error}</Txt>
          <Button label="Retry preview" onPress={() => setAttempt((v) => v + 1)} />
        </>
      ) : !preview ? (
        <Txt>Loading saved version…</Txt>
      ) : preview.kind === "text" ? (
        <Markdown value={preview.text} />
      ) : (
        <>
          <Image
            source={{ uri: preview.uri }}
            accessibilityLabel={`${label}. Static preview of the first screen.`}
            accessible
            style={{ width: "100%", aspectRatio: preview.width / preview.height }}
            resizeMode="contain"
          />
          <Txt tone="secondary">
            Static first-screen preview. Interactive content and the full canvas are available on
            Mac.
          </Txt>
        </>
      )}
    </View>
  );
}
