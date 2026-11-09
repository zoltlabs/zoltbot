import { StyleSheet, Text, View } from "react-native";
import { type Inline, parseMarkdown } from "../data/markdown";
import { mono, useTheme } from "../theme";
import { Txt } from "./kit";

function Spans({ parts }: { parts: Inline[] }) {
  const { c } = useTheme();
  return (
    <>
      {parts.map((part, index) => (
        <Text
          // Inline parts have no identity beyond their position in the line.
          // biome-ignore lint/suspicious/noArrayIndexKey: static parse output
          key={index}
          style={[
            part.bold && styles.bold,
            part.italic && styles.italic,
            part.code && { fontFamily: mono, fontSize: 13, backgroundColor: c["bg-sunken"] },
          ]}
        >
          {part.text}
        </Text>
      ))}
    </>
  );
}

/** Plans and request context as native text: headings, lists, checklists, quotes, code. */
export function Markdown({ value }: { value: string }) {
  const { c } = useTheme();
  const blocks = parseMarkdown(value);
  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "heading")
          return (
            <Txt
              key={key}
              v={block.level <= 2 ? "cardTitle" : "section"}
              accessibilityRole="header"
              style={styles.heading}
            >
              <Spans parts={block.text} />
            </Txt>
          );
        if (block.type === "item")
          return (
            <View key={key} style={[styles.item, { paddingLeft: block.depth * 16 }]}>
              <Txt tone={block.checked ? "ok" : "muted"} style={styles.marker}>
                {block.checked === undefined ? block.marker : block.checked ? "☑" : "☐"}
              </Txt>
              <Txt style={[styles.flex, block.checked && { color: c["text-muted"] }]} tone="text">
                <Spans parts={block.text} />
              </Txt>
            </View>
          );
        if (block.type === "quote")
          return (
            <View key={key} style={[styles.quote, { borderLeftColor: c["border-strong"] }]}>
              <Txt tone="secondary">
                <Spans parts={block.text} />
              </Txt>
            </View>
          );
        if (block.type === "code")
          return (
            <Text
              key={key}
              selectable
              style={[
                styles.code,
                { fontFamily: mono, color: c.text, backgroundColor: c["bg-sunken"] },
              ]}
            >
              {block.text}
            </Text>
          );
        if (block.type === "rule")
          return <View key={key} style={[styles.rule, { backgroundColor: c.border }]} />;
        return (
          <Txt key={key} style={styles.paragraph}>
            <Spans parts={block.text} />
          </Txt>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  heading: { marginTop: 4 },
  paragraph: { lineHeight: 22 },
  item: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 14 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  code: { fontSize: 12, lineHeight: 17, padding: 10, borderRadius: 8, overflow: "hidden" },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
});
