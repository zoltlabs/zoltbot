import { markRecovered } from "@zoltbot/ui/chat/activity-data";
import { fileDiffs } from "@zoltbot/ui/chat/tools/diff-data";
import { executionResult, resultLinks } from "@zoltbot/ui/chat/tools/result-data";
import { images } from "@zoltbot/ui/chat/tools/tool-data";
import { body } from "@zoltbot/ui/chat/types";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, Linking, View } from "react-native";
import { toolTitle } from "../../data/timeline";
import { useSnapshot } from "../../state/link";
import { DetailScreen } from "../../ui/DetailScreen";
import { DiffBlock } from "../../ui/interactions/parts";
import { Button, Txt } from "../../ui/kit";

function ResultImage({ uri, number }: { uri: string; number: number }) {
  const [ratio, setRatio] = useState(1);
  return (
    <Image
      source={{ uri }}
      accessible
      accessibilityLabel={`Tool result image ${number}`}
      resizeMode="contain"
      style={{ width: "100%", aspectRatio: ratio }}
      onLoad={({ nativeEvent: { source } }) => {
        if (source.width && source.height) setRatio(source.width / source.height);
      }}
    />
  );
}

/** Full results stay on a separate screen; opening saved output makes no tool call. */
export default function ToolResult() {
  const { id, item: itemId } = useLocalSearchParams<{ id: string; item: string }>();
  const snapshot = useSnapshot();
  const item = markRecovered(
    [...(snapshot.entities.item ?? [])]
      .filter((row) => row.threadId === id)
      .sort((a, b) => Number(a.seq) - Number(b.seq)),
  ).find((row) => row.id === itemId && row.threadId === id && row.kind === "tool");
  const [limit, setLimit] = useState(200);
  const [error, setError] = useState("");
  if (!item)
    return (
      <DetailScreen title="Tool result">
        <Txt>
          This result is not in the saved history. Return to the chat and reconnect to load it.
        </Txt>
      </DetailScreen>
    );
  const value = body(item);
  const { output, exitCode } = executionResult(value);
  const lines = output.split("\n");
  const diffs = fileDiffs(value.diffs);
  const source =
    value.output && typeof value.output === "object"
      ? (value.output as Record<string, unknown>)
      : {};
  const pictures = images(value.content, source.content, value.output);
  return (
    <DetailScreen title={toolTitle(item)}>
      <Txt v="bodyMedium">
        {value.recovered === true
          ? "Fixed on retry"
          : value.status === "running"
            ? "Running"
            : value.status === "ok"
              ? "Completed"
              : value.status === "denied"
                ? "Denied"
                : "Failed"}
        {exitCode !== undefined ? ` · Exit code ${exitCode}` : ""}
      </Txt>
      {error ? <Txt tone="danger">{error}</Txt> : null}
      {resultLinks(value).map((link) => (
        <View key={link.url} style={{ gap: 8 }}>
          <Button
            label={`${link.label} · ${new URL(link.url).hostname}`}
            onPress={() => {
              void Linking.openURL(link.url).catch(() =>
                setError("Could not open the link. Check your connection and try again."),
              );
            }}
          />
          {link.description ? <Txt tone="secondary">{link.description}</Txt> : null}
        </View>
      ))}
      {diffs.map((diff, index) => (
        // A tool can report the same file more than once; provider order identifies each diff.
        // biome-ignore lint/suspicious/noArrayIndexKey: stable provider diff order
        <DiffBlock key={`${diff.path}:${index}`} diff={diff} initiallyOpen />
      ))}
      {pictures.map((uri, index) => (
        <ResultImage key={uri} uri={uri} number={index + 1} />
      ))}
      {output ? (
        <View style={{ gap: 12 }}>
          <Txt v="section" accessibilityRole="header">
            Output
          </Txt>
          <Txt v="code" selectable>
            {lines.slice(0, limit).join("\n")}
          </Txt>
          {lines.length > limit ? (
            <Button
              label={`Show more output (${lines.length - limit} lines remaining)`}
              onPress={() => setLimit((current) => current + 200)}
            />
          ) : null}
        </View>
      ) : !diffs.length && !pictures.length && !resultLinks(value).length ? (
        <Txt tone="secondary">
          {value.status === "running" ? "Waiting for output…" : "This tool reported no output."}
        </Txt>
      ) : null}
    </DetailScreen>
  );
}
