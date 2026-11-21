import { Value } from "@sinclair/typebox/value";
import { type Connection, ConnectionSchema } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { addableApps, type CatalogApp, canSignIn, signInError } from "../data/connection-sign-in";
import { healthLabel, isConflict, writeError } from "../data/manage";
import { since, text } from "../data/view";
import { useAction } from "../state/actions";
import { signInOnPhone } from "../state/connection-sign-in";
import { useClient, useLink, useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Chip, Group, Row, Section, showConfirmSheet, Txt } from "../ui/kit";
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
const catalogApps = () =>
  call("connection.catalog.list", {}).then(
    (value) => ((value ?? {}) as { items?: CatalogApp[] }).items ?? [],
  );
const where = (connection: Connection) =>
  connection.transport.kind === "https"
    ? connection.transport.url.replace(/^https:\/\//, "").split("/")[0]
    : connection.transport.command;

/**
 * Services agents reach through MCP: whether each answers, a check on demand, and disconnecting.
 * Apps that sign in through Zoltbot's cloud can be added and signed in here (P10); the Mac keeps
 * the sign-in. Everything else is added on the Mac.
 */
export default function Connections() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const snapshot = useSnapshot();
  const [items, setItems] = useState<Connection[]>();
  const [catalog, setCatalog] = useState<CatalogApp[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [signing, setSigning] = useState(false);
  const refresh = () => list().then(setItems, () => setError("Connections could not be loaded."));

  useEffect(() => {
    if (!online) return;
    let live = true;
    list().then(
      (rows) => live && setItems(rows),
      () => live && setError("Connections could not be loaded."),
    );
    // Without the catalog the phone just offers no sign-ins.
    catalogApps().then(
      (apps) => live && setCatalog(apps),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [online]);

  const signIn = async (id: string, name: string) => {
    setError("");
    setNotice("");
    setSigning(true);
    try {
      if (await signInOnPhone(id))
        setNotice(`${name} is connected. Choose which agents can use it on your Mac.`);
    } catch (cause) {
      setError(`${name}: ${signInError(cause)}`);
    } finally {
      setSigning(false);
      await refresh();
    }
  };
  const projects = (snapshot.entities.project ?? []).filter((row) => row.archived !== true);
  const add = (app: CatalogApp) => {
    const install = async (projectId: string) => {
      setError("");
      setSigning(true);
      let installed: Connection;
      try {
        installed = (await call("connection.install", {
          serviceId: app.id,
          projectId,
        })) as Connection;
      } catch (cause) {
        setSigning(false);
        return setError(`${app.name}: ${signInError(cause)}`);
      }
      await signIn(installed.id, app.name);
    };
    if (projects.length === 1) return void install(text(projects[0]?.id));
    pick(
      `Add ${app.name} to`,
      undefined,
      projects.map((row) => text(row.name)),
      (index) => {
        const row = projects[index];
        if (row) void install(text(row.id));
      },
    );
  };
  const addable = items ? addableApps(catalog, items) : [];

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
    const again = canSignIn(connection, catalog)
      ? "Sign in again to reconnect."
      : "Sign in again on your Mac to reconnect.";
    showConfirmSheet({
      title: `Disconnect ${connection.name}?`,
      body: sessions.length
        ? `${sessions.length} running ${sessions.length === 1 ? "chat stops" : "chats stop"}. ${again}`
        : again,
      confirmLabel: `Disconnect ${connection.name}`,
      onConfirm: () =>
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
    });
  };
  const open = (connection: Connection) => {
    const actions = [
      ...(connection.credentialStatus === "needs_sign_in" && canSignIn(connection, catalog)
        ? [{ label: "Sign in", run: () => void signIn(connection.id, connection.name) }]
        : []),
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
        {notice ? <Txt>{notice}</Txt> : null}
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
                  detail={
                    connection.checkedAt ? `Checked ${since(connection.checkedAt)}` : undefined
                  }
                  right={<Chip label={health.label} tone={health.tone} dot />}
                  onPress={online && !busy && !signing ? () => open(connection) : undefined}
                  last={index === items.length - 1}
                />
              );
            })}
          </Group>
        ) : (
          <Txt tone="muted">
            {addable.length && projects.length
              ? "No connections yet."
              : "No connections. Add them on your Mac."}
          </Txt>
        )}
        {addable.length && projects.length ? (
          <>
            <Section title="Add an app" />
            <Group>
              {addable.map((app, index) => (
                <Row
                  key={app.id}
                  title={app.name}
                  detail={app.description}
                  onPress={online && !busy && !signing ? () => add(app) : undefined}
                  last={index === addable.length - 1}
                />
              ))}
            </Group>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
});
