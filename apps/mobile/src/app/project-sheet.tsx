import { terms } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { macFolder, newProject } from "../data/projects";
import { text } from "../data/view";
import { newId, useAction } from "../state/actions";
import { useClient, useSnapshot } from "../state/link";
import { touch, type as typography, useTheme } from "../theme";
import { OfflineBanner } from "../ui/chrome";
import { Button, Group, Row, Txt } from "../ui/kit";

export default function ProjectSheet() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const snapshot = useSnapshot();
  const project = snapshot.entities.project?.find((row) => row.id === id);
  const { c } = useTheme();
  const online = useClient((s) => s.status === "online");
  const { run, busy } = useAction();
  const [name, setName] = useState(text(project?.name));
  const [folder, setFolder] = useState("");
  const locked = !online || busy;
  const save = async () => {
    const result = id
      ? await run("project.update", { id, changes: { name: name.trim() } })
      : await run("project.create", {
          value: newProject(newId("project"), name, folder, new Date().toISOString()),
        });
    if (result) router.back();
  };
  const archive = () =>
    Alert.alert(
      `Archive this ${terms.workspace.one}?`,
      `It will leave your ${terms.workspace.one} list. Its files stay on your Mac.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Archive",
          style: "destructive",
          onPress: () => {
            void run("project.archive", { id, confirmed: true }).then((result) => {
              if (result) router.dismissTo("/projects");
            });
          },
        },
      ],
    );
  const field = {
    ...typography.body,
    minHeight: touch,
    color: c.text,
    backgroundColor: c["bg-raised"],
    borderRadius: c["radius-lg"],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c["border-strong"],
    paddingHorizontal: c["space-3"],
  };
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={{ padding: c["space-5"], gap: c["space-4"] }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Button kind="plain" label="Cancel" onPress={() => router.back()} />
        <Txt v="cardTitle">{id ? `Edit ${terms.workspace.one}` : `New ${terms.workspace.one}`}</Txt>
        <Button
          kind="plain"
          label="Save"
          disabled={
            locked || !name.trim() || (!id && !macFolder(folder)) || Boolean(id && !project)
          }
          onPress={() => void save()}
        />
      </View>
      <OfflineBanner />
      <Txt v="meta" tone="secondary">
        Name
      </Txt>
      <TextInput
        accessibilityLabel={`${terms.workspace.One} name`}
        value={name}
        onChangeText={setName}
        editable={!locked}
        style={field}
      />
      {!id ? (
        <>
          <Txt v="meta" tone="secondary">
            Folder on your Mac
          </Txt>
          <TextInput
            accessibilityLabel="Folder on your Mac"
            value={folder}
            onChangeText={setFolder}
            editable={!locked}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/Users/you/Projects/app"
            placeholderTextColor={c["text-dim"]}
            style={field}
          />
          <Txt v="meta" tone="muted">
            Enter the full path to an existing folder on your Mac. The folder is checked when work
            starts.
          </Txt>
        </>
      ) : null}
      <Group>
        <Row title="Default profile" meta="Set the profile when starting a chat or task." last />
      </Group>
      {id ? (
        <Button
          label={`Archive ${terms.workspace.one}`}
          disabled={locked || !project}
          onPress={archive}
        />
      ) : null}
    </ScrollView>
  );
}
