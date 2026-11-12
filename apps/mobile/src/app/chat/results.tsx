import { threadResults } from "@zoltbot/ui/chat/results-data";
import { router, useLocalSearchParams } from "expo-router";
import { Linking } from "react-native";
import { toolTitle } from "../../data/timeline";
import { text } from "../../data/view";
import { useSnapshot } from "../../state/link";
import { DetailScreen } from "../../ui/DetailScreen";
import { Button, Card, Txt } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

export default function Results() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const snapshot = useSnapshot();
  const data = threadResults(snapshot.entities, id);
  const files = Array.isArray(data.result?.files)
    ? data.result.files.filter((f): f is string => typeof f === "string")
    : [];
  const empty =
    !data.result &&
    !data.artifacts.length &&
    !data.links.length &&
    !data.diffs.length &&
    !data.tools.length &&
    !data.children.length &&
    !data.requests.length;
  return (
    <DetailScreen title="Results">
      {empty ? <Txt>Outputs will appear here as the agent works.</Txt> : null}
      {data.requests.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Needs you
          </Txt>
          {data.requests.map((r) => (
            <Button
              key={text(r.id)}
              label={text(r.title) || "Review request"}
              onPress={() => router.push(`/inbox/${encodeURIComponent(id)}`)}
            />
          ))}
        </Card>
      ) : null}
      {data.result?.summary ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Outcome
          </Txt>
          <Markdown value={text(data.result.summary)} />
        </Card>
      ) : null}
      {data.artifacts.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Artifacts
          </Txt>
          {data.artifacts.map((a) => (
            <Button
              key={text(a.id)}
              label={`${text(a.title)} · view versions`}
              onPress={() =>
                router.push(
                  `/chat/artifacts?id=${encodeURIComponent(id)}&versionId=${encodeURIComponent(text(a.currentVersionId))}`,
                )
              }
            />
          ))}
          <Button
            label="Compare saved versions"
            onPress={() => router.push(`/chat/artifacts?id=${encodeURIComponent(id)}`)}
          />
        </Card>
      ) : null}
      {files.length || data.diffs.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Files and changes
          </Txt>
          {files.map((file) => (
            <Txt key={file}>{file}</Txt>
          ))}
          {[...new Set(data.diffs.map((diff) => diff.path))].map((file) => (
            <Txt key={file}>{file}</Txt>
          ))}
          <Button
            label="Review file changes"
            onPress={() => router.push(`/chat/changes?id=${encodeURIComponent(id)}`)}
          />
        </Card>
      ) : null}
      {data.tools.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Tool results
          </Txt>
          {data.tools.map((item) => (
            <Button
              key={text(item.id)}
              label={toolTitle(item)}
              onPress={() =>
                router.push(
                  `/chat/tool?id=${encodeURIComponent(id)}&item=${encodeURIComponent(text(item.id))}`,
                )
              }
            />
          ))}
        </Card>
      ) : null}
      {data.links.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Links
          </Txt>
          {data.links.map((link) => (
            <Button
              key={link.url}
              label={`${link.label} · ${new URL(link.url).hostname}`}
              onPress={() => {
                void Linking.openURL(link.url);
              }}
            />
          ))}
        </Card>
      ) : null}
      {data.children.length ? (
        <Card>
          <Txt v="cardTitle" accessibilityRole="header">
            Delegated work
          </Txt>
          {data.children.map((child) => (
            <Button
              key={text(child.id)}
              label={`${text(child.title) || "Chat"} · ${text(child.state).replaceAll("_", " ")}`}
              onPress={() => router.push(`/chat/${text(child.threadId)}`)}
            />
          ))}
        </Card>
      ) : null}
      {data.task ? (
        <Button label="Review task" onPress={() => router.push("/(tabs)/tasks")} />
      ) : null}
    </DetailScreen>
  );
}
