import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, AppState, StyleSheet, View } from "react-native";
import { type PhonePref, preferenceKey, readPhonePrefs } from "../../data/preferences";
import { since, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { type ThemePreference, usePrefs } from "../../state/prefs";
import { usePush } from "../../state/push";
import { TabScreen } from "../../ui/chrome";
import { Button, Chip, Group, Row, Section, Segmented, Txt } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";

export default function Settings() {
  const prefs = usePrefs();
  const push = usePush();
  const snapshot = useSnapshot();
  const { status, kind, lastSeenAt } = useClient((state) => state);
  const { macName, fake, deviceId } = useLink();
  const { run, busy } = useAction();
  const [logins, setLogins] = useState<Record<string, string>>({});
  const definitions = snapshot.entities.agentDefinition ?? [];
  const devices = (snapshot.entities.device ?? []).filter(
    (d) => d.state !== "revoked" && d.archived !== true,
  );
  const online = status === "online";
  const synced = readPhonePrefs(snapshot.entities.settings ?? [], deviceId);
  const change = async (field: PhonePref, value: boolean) => {
    await run("settings.set", { key: preferenceKey(deviceId, field), value });
  };
  useEffect(() => {
    void usePush.getState().refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void usePush.getState().refresh();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!online) return;
    const client = useLink.getState().client;
    for (const definition of definitions)
      void client
        ?.getState()
        .call("detect.checkLogin", { definitionId: definition.id })
        .then((result) =>
          setLogins((now) => ({
            ...now,
            [text(definition.id)]: text((result as { state?: string }).state),
          })),
        )
        .catch(() => undefined);
  }, [online, definitions]);

  const remove = (id: string, name: string) =>
    Alert.alert(
      `Remove ${name}?`,
      "It stops reaching your Mac at once. You can pair it again later.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void run("device.revoke", { id, confirmed: true }),
        },
      ],
    );
  const unpair = () =>
    Alert.alert(
      "Unpair this iPhone?",
      "It forgets your Mac. You can scan a new code to pair again.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: () => void useLink.getState().disconnect(),
        },
      ],
    );

  return (
    <TabScreen title="Settings">
      <Section title="Appearance" />
      <Segmented<ThemePreference>
        label="Theme"
        value={prefs.theme}
        onChange={(theme) => prefs.set({ theme })}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />

      {fake ? (
        <>
          <Section title="Sample data" />
          <Group>
            <Toggle
              label="Mac online"
              note="Turn off to see the offline view."
              value={status !== "mac_offline"}
              onChange={(value) => fake.setMacOnline(value)}
              last
            />
          </Group>
          <View style={styles.row}>
            <Button
              label="Pair a real Mac"
              onPress={() => void useLink.getState().disconnect()}
              style={styles.flex}
            />
          </View>
        </>
      ) : null}
      <Section title="Notifications" />
      <Group>
        <Toggle
          label="Needs you"
          value={synced.notifyNeedsYou}
          disabled={!online || busy}
          onChange={(v) => void change("notifyNeedsYou", v)}
        />
        <Toggle
          label="Task results"
          value={synced.notifyResults}
          disabled={!online || busy}
          onChange={(v) => void change("notifyResults", v)}
          last
        />
      </Group>

      <Group>
        <Row
          title="Push permission"
          meta={push.label}
          right={
            <Button
              label="Enable"
              disabled={!online || push.busy || push.label === "Allowed" || push.label === "Denied"}
              onPress={() => void push.refresh(true)}
            />
          }
          last
        />
      </Group>
      <Txt v="meta" tone="muted">
        Push delivery is not connected yet.
      </Txt>
      {kind === "fake" ? (
        <Txt v="meta" tone="muted">
          Sample data does not pair a Mac. Enable lets you test the permission prompt.
        </Txt>
      ) : null}
      <Section title="Manage" />
      <Group>
        <Row title="Routines" onPress={() => router.push("/routines")} />
        <Row title="Knowledge" onPress={() => router.push("/knowledge")} />
        <Row title="Skills" onPress={() => router.push("/skills")} />
        <Row title="Connections" onPress={() => router.push("/connections")} last />
      </Group>

      <Section title="Devices" />
      <Group>
        <Row
          title={macName || "Your Mac"}
          meta={
            online
              ? "Runs your agents"
              : lastSeenAt
                ? `Last seen ${since(lastSeenAt)}`
                : "Runs your agents"
          }
          right={
            <Chip label={online ? "Connected" : "Offline"} tone={online ? "ok" : "neutral"} dot />
          }
        />
        {devices.map((device, index) => {
          const self = device.id === deviceId;
          const name = text(device.name);
          return (
            <Row
              key={text(device.id)}
              title={name}
              meta={
                self ? `Paired ${since(device.pairedAt)}` : `Last seen ${since(device.lastSeenAt)}`
              }
              right={
                self ? undefined : (
                  <Button
                    label="Remove"
                    disabled={!online}
                    onPress={() => remove(text(device.id), name)}
                    a11y={`Remove ${name}`}
                  />
                )
              }
              last={index === devices.length - 1}
            />
          );
        })}
      </Group>
      {kind === "relay" ? <Button label="Unpair this iPhone" onPress={unpair} /> : null}

      <Section title="Coding tools" />
      <Group>
        {definitions.map((definition, index) => {
          const state = logins[text(definition.id)];
          return (
            <Row
              key={text(definition.id)}
              title={text(definition.displayName)}
              right={
                <Txt v="meta" tone={state === "signed_in" ? "ok" : "muted"}>
                  {state === "signed_in" || state === "api_key_configured"
                    ? "Signed in"
                    : state === "signed_out"
                      ? "Finish sign in on your Mac"
                      : "Checking"}
                </Txt>
              }
              last={index === definitions.length - 1}
            />
          );
        })}
      </Group>
    </TabScreen>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: "row" }, flex: { flex: 1 } });
