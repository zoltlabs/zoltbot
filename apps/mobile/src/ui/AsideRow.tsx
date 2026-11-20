// C2: one line of a side question, indented under the chat. The answer offers Continue in new
// chat, which lists the aside as a normal chat and opens it.
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import type { TranscriptRow } from "../data/view";
import { useAction } from "../state/actions";
import { useTheme } from "../theme";
import { Button, Txt } from "./kit";
import { Markdown } from "./Markdown";

export function AsideRow({ row }: { row: TranscriptRow }) {
  const { c } = useTheme();
  const { run, busy } = useAction();
  const aside = row.aside;
  if (!aside) return null;
  const keep = async () => {
    const kept = await run("thread.continueAside", { id: aside.threadId });
    if (kept) router.push(`/chat/${aside.threadId}`);
  };
  return (
    <View style={[styles.aside, { borderLeftColor: c.border, backgroundColor: c["bg-raised"] }]}>
      {aside.question ? (
        <Txt v="meta" tone="muted">
          Aside
        </Txt>
      ) : null}
      {/* The prefix sits on the text, so the Continue button stays reachable on its own. */}
      <View
        accessible
        accessibilityLabel={
          aside.question
            ? `Side question: ${row.text}`
            : row.text
              ? `Answer to side question: ${row.text}`
              : row.status === "failed"
                ? "Side question failed"
                : "Answering side question"
        }
      >
        {aside.question ? (
          <Txt>{row.text}</Txt>
        ) : row.text ? (
          <Markdown value={row.text} />
        ) : (
          <Txt tone="muted">
            {row.status === "failed" ? "Couldn’t ask. Try again." : "Answering…"}
          </Txt>
        )}
      </View>
      {!aside.question && row.text && !row.streaming ? (
        <Button
          kind="plain"
          label="Continue in new chat"
          disabled={busy}
          onPress={() => void keep()}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  aside: {
    marginLeft: 24,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 4,
    borderLeftWidth: 2,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
  },
});
