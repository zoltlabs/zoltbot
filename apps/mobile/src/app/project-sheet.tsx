import { terms } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { macFolder, newProject } from "../data/projects";
import { text } from "../data/view";
import { newId, useAction } from "../state/actions";
import { useClient, useSnapshot } from "../state/link";
import { touch, type as typography, useTheme } from "../theme";
import { OfflineBanner } from "../ui/chrome";
import { Button, showConfirmSheet, Txt } from "../ui/kit";

export default function ProjectSheet() {
  const { id, repoId } = useLocalSearchParams<{ id?: string; repoId?: string }>();
  const snapshot = useSnapshot();
  const project = snapshot.entities.project?.find(
    (row) => row.id === (repoId ?? id) && !row.archived,
  );
  const { c } = useTheme();
  const online = useClient((s) => s.status === "online");
  const { run, busy } = useAction();
  const [name, setName] = useState(id ? text(project?.name) : "");
  const [folder, setFolder] = useState("");
  const locked = !online || busy;
  const save = async () => {
    const at = new Date().toISOString();
    const result = id
      ? await run("project.update", { id, changes: { name: name.trim() } })
      : repoId
        ? await run(
            "subproject.create",
            {
              value: {
                id: newId("project"),
                projectId: repoId,
                name: name.trim(),
                label: "Project",
                depth: 1,
                goal: "",
                instructions: "",
                archived: false,
                createdAt: at,
              },
            },
            { key: JSON.stringify(["project", repoId, name.trim()]) },
          )
        : await run(
            "project.create",
            {
              value: newProject(newId("repo"), name, folder, at),
            },
            { key: JSON.stringify(["repo", name.trim(), folder.trim()]) },
          );
    if (result) router.back();
  };
  const archive = () =>
    showConfirmSheet({
      title: `Archive this ${terms.workspace.one}?`,
      body: `It will leave your ${terms.workspace.one} list. Its files stay on your Mac.`,
      confirmLabel: `Archive ${terms.workspace.one}`,
      onConfirm: () => {
        void run("project.archive", { id, confirmed: true }).then((result) => {
          if (result) router.dismissTo("/projects");
        });
      },
    });
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
        <Txt v="cardTitle">
          {id ? `Edit ${terms.workspace.one}` : repoId ? "New project" : "New repo"}
        </Txt>
        <Button
          kind="plain"
          label="Save"
          disabled={
            locked ||
            !name.trim() ||
            (!id && !repoId && !!folder.trim() && !macFolder(folder)) ||
            Boolean((id || repoId) && !project)
          }
          onPress={() => void save()}
        />
      </View>
      <OfflineBanner />
      <Txt v="meta" tone="secondary">
        Name
      </Txt>
      <TextInput
        accessibilityLabel={repoId ? "Project name" : "Repo name"}
        maxLength={150}
        value={name}
        onChangeText={setName}
        editable={!locked}
        style={field}
      />
      {!id && !repoId ? (
        <>
          <Txt v="meta" tone="secondary">
            Folder on your Mac (optional)
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
