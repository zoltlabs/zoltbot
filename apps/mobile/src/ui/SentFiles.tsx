import { router } from "expo-router";
import { View } from "react-native";
import type { SentFile } from "../data/timeline";
import { useTheme } from "../theme";
import { Icon } from "./icons";
import { Button } from "./kit";

/** C16: files and pictures sent with a message. Each opens a preview from the Mac. */
export function SentFiles({
  files,
  threadId,
  itemId,
}: {
  files: SentFile[];
  threadId?: string | undefined;
  itemId: string;
}) {
  const { c } = useTheme();
  if (!threadId) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
      {files.map((file) => (
        <Button
          key={file.part}
          label={file.name}
          a11y={`Preview ${file.name}`}
          icon={<Icon name="attach" color={c["text-secondary"]} size={c["space-5"]} />}
          onPress={() => {
            const where = `id=${encodeURIComponent(threadId)}&item=${encodeURIComponent(itemId)}&part=${file.part}`;
            // A picture opens the chat's gallery (C17); any other file its own preview.
            router.push(
              file.kind === "image"
                ? `/chat/gallery?${where}`
                : `/chat/attachment?${where}&name=${encodeURIComponent(file.name)}`,
            );
          }}
        />
      ))}
    </View>
  );
}
