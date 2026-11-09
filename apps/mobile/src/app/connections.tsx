import { Value } from "@sinclair/typebox/value";
import { type Connection, ConnectionSchema } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { healthLabel, isConflict, writeError } from "../data/manage";
import { since } from "../data/view";
import { useAction } from "../state/actions";
import { useClient, useLink } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Chip, Group, Row, Txt } from "../ui/kit";
import { pick } from "../ui/SessionControls";

const call = (method: string, params: unknown) =>
  useLink.getState().client?.getState().call(method, params) ??
  Promise.reject(new Error("Not connected to your Mac."));
const list = () =>
  call("connection.list", {}).then((value) =>
    (((value ?? {}) as { items?: unknown[] }).items ?? []).filter((row): row is Connection =>
      Value.Check(ConnectionSchema, row),
    ),
  );
const where = (connection: Connection) =>
  connection.transport.kind === "https"
    ? connection.transport.url.replace(/^https:\/\//, "").split("/")[0]
    : connection.transport.command;

/**
 * Services agents reach through MCP: whether each answers, a check on demand, and disconnecting.
 * Adding and signing in stay on the Mac, which holds the keys.
 */
export default function Connections() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const [items, setItems] = useState<Connection[]>();
  const [error, setError] = useState("");
  const refresh = () => list().then(setItems, () => setError("Connections could not be loaded."));

  useEffect(() => {
    if (!online) return;
    let live = true;
    list().then(
      (rows) => live && setItems(rows),
      () => live && setError("Connections could not be loaded."),
    );
    return () => {
      live = false;
    };
  }, [online]);

  const check = async (connection: Connection) => {
    setError("");
    await run("connection.test", { id: connection.id }, { quiet: true }).catch((cause: unknown) =>
      setError(`${connection.name}: ${writeError(cause)}`),
    );
    await refresh();
  };
  const disconnect = async (connection: Connection) => {
    setError("");
    const sessions = await call("connection.affectedSessions", { id: connection.id })
      .then((value) => ((value ?? {}) as { sessionIds?: string[] }).sessionIds ?? [])
      .catch(() => undefined);
    if (!sessions) return setError("Could not check which chats use it.");
    Alert.alert(
      `Disconnect ${connection.name}?`,
      sessions.length
        ? `${sessions.length} running ${sessions.length === 1 ? "chat stops" : "chats stop"}. Sign in again on your Mac to reconnect.`
        : "Sign in again on your Mac to reconnect.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () =>
            void run(
              "connection.disconnect",
              {
                id: connection.id,
                confirmed: true,
                stopSessions: sessions.length > 0,
                expectedVersion: connection.version,
                expectedSessionIds: sessions,
              },
              { quiet: true },
            )
              .catch((cause: unknown) =>
                setError(
                  isConflict(cause)
                    ? `${connection.name} changed on your Mac. Check it and try again.`
                    : writeError(cause),
                ),
              )
              .then(refresh),
        },
      ],
    );
  };
  const open = (connection: Connection) => {
    const actions = [
      { label: "Check now", run: () => void check(connection) },
      ...(connection.enabled || connection.credentialStatus === "connected"
        ? [{ label: "Disconnect", run: () => void disconnect(connection) }]
        : []),
    ];
    pick(
      connection.name,
      where(connection),
      actions.map((action) => action.label),
      (index) => actions[index]?.run(),
    );
  };

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Settings" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Connections
        </Txt>
        <OfflineBanner />
        {error ? <Txt tone="danger">{error}</Txt> : null}
        {!items ? (
          <Txt tone="muted">
            {online ? "Loading…" : "Connections load when your Mac is online."}
          </Txt>
        ) : items.length ? (
          <Group>
            {items.map((connection, index) => {
              const health = healthLabel(connection);
              return (
                <Row
                  key={connection.id}
                  title={connection.name}
                  meta={[
                    where(connection),
                    connection.checkedAt ? `Checked ${since(connection.checkedAt)}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  right={<Chip label={health.label} tone={health.tone} dot />}
                  onPress={online && !busy ? () => open(connection) : undefined}
                  last={index === items.length - 1}
                />
              );
            })}
          </Group>
        ) : (
          <Txt tone="muted">No connections. Add them on your Mac.</Txt>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
});
