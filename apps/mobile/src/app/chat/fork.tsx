import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { forkReason } from "../../data/forks";
import type { Row as Entity } from "../../data/transport";
import { text } from "../../data/view";
import { newId } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { mono, touch, type as typography, useTheme } from "../../theme";
import { OfflineBanner } from "../../ui/chrome";
import { Button, Group, Row, Section, Segmented, Txt } from "../../ui/kit";

type Method = "" | "native" | "copied";
interface Attempt {
  id: string;
  title: string;
  destination: string;
  kind: string;
}
/**
 * Fork attempts the Mac has not confirmed, by chat, for as long as the app runs (the desktop keeps
 * them in sessionStorage). Reopening the sheet retries the same attempt, never a second fork.
 */
const pending = new Map<string, Attempt>();

/** Fork a chat into the agent you choose, like the desktop's Fork conversation. */
export default function Fork() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const thread = snapshot.entities.thread?.find((row) => row.id === id);
  const saved = pending.get(id);
  const [name, setName] = useState(saved?.title ?? `${text(thread?.title) || "Chat"} · fork`);
  const [destination, setDestination] = useState(saved?.destination ?? "");
  const [method, setMethod] = useState<Method>((saved?.kind as Method | undefined) ?? "");
  const [preview, setPreview] = useState<Entity>();
  const [destinations, setDestinations] = useState<Entity[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    let live = true;
    setPreview(undefined);
    client
      .call("thread.forkPreview", {
        id,
        ...(destination ? { destinationProfileId: destination } : {}),
        ...(method ? { kind: method } : {}),
      })
      .then((value) => {
        if (!live) return;
        const row = (value ?? {}) as Entity;
        setPreview(row);
        if (Array.isArray(row.destinations)) setDestinations(row.destinations as Entity[]);
      })
      .catch(() => live && setError("Could not check whether this chat can fork."));
    return () => {
      live = false;
    };
  }, [id, destination, method]);

  const create = async () => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    const attempt = pending.get(id) ?? {
      id: newId("fork"),
      title: name.trim(),
      destination,
      kind: method || text(preview?.kind),
    };
    pending.set(id, attempt);
    setWorking(true);
    setError("");
    try {
      const operation = (await client.call(
        "thread.fork",
        {
          id,
          title: attempt.title,
          ...(attempt.destination ? { destinationProfileId: attempt.destination } : {}),
          ...(attempt.kind ? { kind: attempt.kind } : {}),
        },
        attempt.id,
      )) as Entity;
      if (operation.state !== "ready") {
        setError("Your Mac has not confirmed the fork yet. Trying again checks the same one.");
        return;
      }
      pending.delete(id);
      router.dismiss();
      router.push(`/chat/${text(operation.childThreadId)}`);
    } catch {
      setError("The fork was not confirmed. Trying again checks the same one.");
    } finally {
      setWorking(false);
    }
  };

  const locked = working || !!saved;
  const kind = text(preview?.kind);
  const carries =
    preview?.available !== true
      ? ""
      : kind === "copied"
        ? `Copies ${Number(preview.copiedMessages)} ${Number(preview.copiedMessages) === 1 ? "message" : "messages"} as context for your first message${Number(preview.omittedMessages) ? `; ${Number(preview.omittedMessages)} older left out` : ""}. Attachments, thinking and tool state stay behind.`
        : "Keeps the agent's own conversation state. Nothing is resent.";
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.page}
    >
      <View style={styles.head}>
        <Button kind="plain" label="Cancel" disabled={working} onPress={() => router.back()} />
        <Txt v="cardTitle" accessibilityRole="header">
          Fork chat
        </Txt>
        <Button
          kind="plain"
          label={working ? "Forking…" : saved ? "Check" : "Fork"}
          a11y={saved ? "Check the saved fork" : "Fork"}
          disabled={working || !online || !name.trim() || (!saved && preview?.available !== true)}
          onPress={() => void create()}
        />
      </View>
      <OfflineBanner />

      <Section title="Agent" />
      <Group>
        <Row
          title="Same agent"
          checked={destination === ""}
          disabled={locked}
          onPress={() => setDestination("")}
          last={!destinations.length}
        />
        {destinations.map((profile, index) => (
          <Row
            key={text(profile.id)}
            title={text(profile.name)}
            meta={text(profile.tool)}
            checked={destination === text(profile.id)}
            disabled={locked}
            onPress={() => setDestination(text(profile.id))}
            last={index === destinations.length - 1}
          />
        ))}
      </Group>

      <Section title="Carry over" />
      <Segmented<Method>
        label="Carry over"
        value={method}
        onChange={setMethod}
        disabled={locked}
        options={[
          { value: "", label: "Automatic" },
          { value: "native", label: "Native" },
          { value: "copied", label: "Copy" },
        ]}
      />
      {preview?.available === false ? (
        <Txt tone="danger">{forkReason(preview.reason)}</Txt>
      ) : preview ? (
        <Txt v="meta" tone="muted">
          {carries}
        </Txt>
      ) : (
        <Txt v="meta" tone="muted">
          Checking…
        </Txt>
      )}

      <Section title="Name" />
      <TextInput
        value={name}
        onChangeText={setName}
        editable={!locked}
        maxLength={200}
        accessibilityLabel="Name"
        style={[
          typography.body,
          styles.input,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
        ]}
      />
      {text(preview?.cwd) ? (
        <Txt v="meta" tone="muted" style={{ fontFamily: mono }}>
          {`Same files: ${text(preview?.cwd)}`}
        </Txt>
      ) : null}
      {error ? <Txt tone="danger">{error}</Txt> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { minHeight: touch, borderRadius: 12, borderWidth: 1, paddingHorizontal: 14 },
});
