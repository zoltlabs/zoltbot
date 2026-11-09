import { terms } from "@zoltbot/protocol";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useRef, useState } from "react";
import { Alert, Modal, ScrollView, TextInput, View } from "react-native";
import {
  type Attachment,
  attachmentAccess,
  type FileChoice,
  searchSampleFiles,
} from "../data/attachments";
import { text } from "../data/view";
import { newId } from "../state/actions";
import { useCall, useClient, useLink } from "../state/link";
import { touch, type as typography, useTheme } from "../theme";
import { OfflineBanner } from "./chrome";
import { Icon } from "./icons";
import { Button, Chip, Group, Row, Txt } from "./kit";

export function Attachments({
  value,
  onChange,
  threadId,
  disabled = false,
}: {
  value: Attachment[];
  onChange(value: Attachment[]): void;
  threadId?: string | undefined;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const online = useClient((s) => s.status === "online");
  const kind = useClient((s) => s.kind);
  const call = useCall();
  const access = attachmentAccess(kind, threadId);
  const [sheet, setSheet] = useState<"choices" | "search" | undefined>();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileChoice[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const locked = disabled || !online || busy;
  const add = (label: string, part: Attachment["part"]) => {
    if (useLink.getState().client?.getState().status !== "online") return;
    onChange([...value, { id: newId("attachment"), label, part }]);
    setSheet(undefined);
  };
  const pick = async (photo: boolean) => {
    if (locked) return;
    setBusy(true);
    try {
      if (photo) {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          base64: true,
          quality: 0.7,
        });
        const asset = result.canceled ? undefined : result.assets[0];
        if (asset?.base64)
          add(asset.fileName ?? "Photo", {
            type: "image",
            base64: asset.base64,
            mimeType: "image/jpeg",
          });
      } else if (kind === "fake") {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        const asset = result.canceled ? undefined : result.assets[0];
        // Sample only. Never pass the phone's local URI to the relay as a Mac path.
        if (asset) add(asset.name, { type: "file", path: `/sample/attachments/${asset.name}` });
      }
    } catch (error) {
      Alert.alert("Could not attach", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const search = async (next: string) => {
    setQuery(next);
    const ticket = ++request.current;
    setFiles([]);
    setNote("Searching");
    try {
      const result =
        kind === "fake" && !threadId
          ? searchSampleFiles(next)
          : ((await call("workspace.files", { threadId, query: next, limit: 20 })) as {
              items: FileChoice[];
              truncated: boolean;
            });
      if (ticket !== request.current) return;
      setFiles(result.items);
      setNote(
        result.truncated
          ? "More files match. Type a longer name."
          : result.items.length
            ? ""
            : "No matching files.",
      );
    } catch (error) {
      if (ticket === request.current) setNote(error instanceof Error ? error.message : text(error));
    }
  };
  return (
    <View style={{ gap: c["space-2"] }}>
      {value.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: c["space-2"] }}>
          {value.map((attachment) => (
            <Button
              key={attachment.id}
              label="Remove"
              a11y={`Remove attachment ${attachment.label}`}
              disabled={locked}
              icon={<Chip label={attachment.label} />}
              onPress={() => onChange(value.filter((entry) => entry.id !== attachment.id))}
            />
          ))}
        </View>
      ) : null}
      <Button
        icon={<Icon name="attach" color={c["text-secondary"]} size={c["space-6"]} />}
        label="Attach"
        a11y="Add a file or photo"
        disabled={locked}
        onPress={() => setSheet("choices")}
      />
      <Modal
        visible={Boolean(sheet)}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setSheet(undefined)}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ backgroundColor: c["bg-page"] }}
          contentContainerStyle={{ padding: c["space-5"], gap: c["space-4"] }}
        >
          <View
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
          >
            <Txt v="cardTitle">
              {sheet === "search" ? `Files in this ${terms.workspace.one}` : "Attach"}
            </Txt>
            <Button
              label="Done"
              onPress={() => {
                ++request.current;
                setSheet(undefined);
              }}
            />
          </View>
          <OfflineBanner />
          {sheet === "choices" ? (
            <>
              <Button
                label="Photo"
                disabled={locked || !access.photo}
                onPress={() => void pick(true)}
              />
              <Button
                label="File"
                disabled={locked || !access.file}
                onPress={() => void pick(false)}
              />
              {!access.file ? (
                <Txt v="meta" tone="muted">
                  Sending files from this iPhone needs Mac upload support. Photos are available.
                </Txt>
              ) : (
                <Txt v="meta" tone="muted">
                  File uploads use sample data only.
                </Txt>
              )}
              <Button
                label={`Files in this ${terms.workspace.one}`}
                disabled={locked || !access.search}
                onPress={() => {
                  setSheet("search");
                  void search("");
                }}
              />
              {!access.search ? (
                <Txt v="meta" tone="muted">
                  Start the chat first to search its workspace on your Mac.
                </Txt>
              ) : null}
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Search files"
                autoCorrect={false}
                autoCapitalize="none"
                placeholder="Search by name"
                placeholderTextColor={c["text-dim"]}
                value={query}
                maxLength={256}
                editable={!locked}
                onChangeText={(next) => void search(next)}
                style={{
                  ...typography.body,
                  minHeight: touch,
                  color: c.text,
                  backgroundColor: c["bg-raised"],
                  paddingHorizontal: c["space-3"],
                  borderRadius: c["radius-lg"],
                }}
              />
              {note ? (
                <Txt v="meta" tone="muted">
                  {note}
                </Txt>
              ) : null}
              <Group>
                {files.map((file, index) => (
                  <Row
                    key={file.path}
                    title={file.label}
                    label={`Attach ${file.label}`}
                    disabled={locked}
                    last={index === files.length - 1}
                    onPress={() => add(file.label, { type: "file", path: file.path })}
                  />
                ))}
              </Group>
            </>
          )}
        </ScrollView>
      </Modal>
    </View>
  );
}
