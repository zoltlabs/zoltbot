import { Value } from "@sinclair/typebox/value";
import { type KnowledgeItem, KnowledgeItemSchema, type Scope } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import {
  blankKnowledge,
  isConflict,
  kindLabel,
  knowledgeKinds,
  userScope,
  writeError,
} from "../data/manage";
import { text } from "../data/view";
import { newId, useAction } from "../state/actions";
import { useClient, useSnapshot } from "../state/link";
import { sans, touch, type as typography, useTheme } from "../theme";
import { Conflict } from "../ui/Conflict";
import { OfflineBanner } from "../ui/chrome";
import { Button, Group, Row, Section, Txt } from "../ui/kit";
import { pick } from "../ui/SessionControls";

/**
 * Add or edit one knowledge entry. Every save names the revision it was made from, so an edit
 * made on the Mac in the meantime is shown next to this one instead of being overwritten.
 */
export default function KnowledgeEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const row = id ? snapshot.entities.knowledge?.find((entry) => entry.id === id) : undefined;
  const current = Value.Check(KnowledgeItemSchema, row) ? (row as KnowledgeItem) : undefined;
  const projects = (snapshot.entities.project ?? []).filter((project) => project.archived !== true);
  const [base] = useState(
    () => current ?? blankKnowledge(newId("knowledge"), userScope, new Date().toISOString()),
  );
  const [scope, setScope] = useState<Scope>(base.scope);
  const [kind, setKind] = useState(base.kind);
  const [title, setTitle] = useState(base.title);
  const [body, setBody] = useState(base.body);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const locked = !online || busy;

  const save = async (expectedRevision: number) => {
    setError("");
    try {
      await run(
        "knowledge.upsert",
        {
          value: { ...(current ?? base), scope, kind, title: title.trim(), body: body.trim() },
          expectedRevision,
        },
        { quiet: true },
      );
      router.back();
    } catch (cause) {
      if (isConflict(cause)) setConflict(true);
      else setError(writeError(cause));
    }
  };
  const archive = () =>
    Alert.alert("Archive this entry?", "Agents stop seeing it in new chats.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Archive",
        style: "destructive",
        onPress: () =>
          void run(
            "knowledge.archive",
            { id: base.id, expectedRevision: current?.revision ?? base.revision },
            { quiet: true },
          ).then(
            () => router.back(),
            (cause: unknown) => setError(writeError(cause)),
          ),
      },
    ]);

  const field = [
    typography.body,
    styles.input,
    { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
  ];
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.page}
    >
      <View style={styles.head}>
        <Button kind="plain" label="Cancel" disabled={busy} onPress={() => router.back()} />
        <Txt v="cardTitle" accessibilityRole="header">
          {id ? "Edit knowledge" : "New knowledge"}
        </Txt>
        <Button
          kind="plain"
          label={busy ? "Saving…" : "Save"}
          disabled={locked || conflict || !title.trim() || !body.trim() || (!!id && !current)}
          onPress={() => void save(id ? base.revision : 0)}
        />
      </View>
      <OfflineBanner />
      {id && !current ? <Txt tone="muted">This entry was archived on your Mac.</Txt> : null}
      {conflict && current ? (
        <Conflict
          mac={`${current.title}: ${current.body}`}
          mine={`${title.trim()}: ${body.trim()}`}
          busy={locked}
          onKeep={() => router.back()}
          onSave={() => {
            setConflict(false);
            void save(current.revision);
          }}
        />
      ) : null}
      {error ? <Txt tone="danger">{error}</Txt> : null}

      {id ? null : (
        <>
          <Section title="Applies to" />
          <Group>
            <Row
              title="You"
              meta="Every project"
              checked={scope.type === "user"}
              disabled={locked}
              onPress={() => setScope(userScope)}
              last={!projects.length}
            />
            {projects.map((project, index) => (
              <Row
                key={text(project.id)}
                title={text(project.name)}
                checked={scope.type === "project" && scope.id === project.id}
                disabled={locked}
                onPress={() => setScope({ type: "project", id: text(project.id) })}
                last={index === projects.length - 1}
              />
            ))}
          </Group>
        </>
      )}

      <Group>
        <Row
          title="Kind"
          right={<Txt tone="accent">{kindLabel(kind)}</Txt>}
          disabled={locked}
          onPress={() =>
            pick("Kind", undefined, knowledgeKinds.map(kindLabel), (index) => {
              const next = knowledgeKinds[index];
              if (next) setKind(next);
            })
          }
          last
        />
      </Group>
      <TextInput
        value={title}
        onChangeText={setTitle}
        editable={!locked}
        placeholder="Title"
        maxLength={200}
        accessibilityLabel="Title"
        style={field}
      />
      <TextInput
        value={body}
        onChangeText={setBody}
        editable={!locked}
        multiline
        placeholder="What agents should know"
        maxLength={1200}
        accessibilityLabel="Body"
        style={[...field, styles.body]}
      />
      {id && current ? (
        <Button kind="secondary" label="Archive" disabled={locked} onPress={archive} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { minHeight: touch, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
  body: {
    fontFamily: sans,
    minHeight: 140,
    maxHeight: 320,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
});
