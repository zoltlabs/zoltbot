import { chiefName } from "@zoltbot/ui/chief/data";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { type PhonePref, preferenceKey, readPhonePrefs } from "../../data/preferences";
import { since, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { appIconAvailable, useAppIcon } from "../../state/app-icon";
import { useCloud } from "../../state/cloud";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { type ThemePreference, usePrefs } from "../../state/prefs";
import { usePush } from "../../state/push";
import { TabScreen } from "../../ui/chrome";
import { Button, Group, Row, Section, Segmented, showConfirmSheet, Txt } from "../../ui/kit";
import { LockSettings } from "../../ui/LockSettings";
import { MacSettings } from "../../ui/MacList";
import { TextSizeSettings } from "../../ui/TextSizeSettings";
import { Toggle } from "../../ui/Toggle";
import { VoiceSettings } from "../../ui/VoiceSettings";

export default function Settings() {
  const prefs = usePrefs();
  const appIcon = useAppIcon((state) => state.current);
  const cloud = useCloud((state) => state.account);
  const push = usePush();
  const snapshot = useSnapshot();
  const { status, kind } = useClient((state) => state);
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
    void useAppIcon.getState().refresh();
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
    showConfirmSheet({
      title: `Remove ${name}?`,
      body: "It stops reaching your Mac at once. You can pair it again later.",
      confirmLabel: "Remove device",
      onConfirm: () => void run("device.revoke", { id, confirmed: true }),
    });

  return (
    <TabScreen title="Settings">
      {cloud.configured ? (
        <Group>
          <Row
            title="Zoltbot Cloud"
            detail={cloud.account?.user.email ?? (cloud.signedIn ? "Account offline" : "Sign in")}
            onPress={() => router.push("/cloud-account")}
            last
          />
        </Group>
      ) : null}
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
      <TextSizeSettings />
      {appIconAvailable ? (
        <Group>
          <Row
            title="App icon"
            detail={appIcon.name}
            onPress={() => router.push("/app-icon")}
            last
          />
        </Group>
      ) : null}
      <VoiceSettings />
      <Section title="Privacy" />
      <LockSettings />

      {fake ? (
        <>
          <Section title="Sample data" />
          <Group>
            <Toggle
              label="Mac online"
              value={status !== "mac_offline"}
              onChange={(value) => fake.setMacOnline(value)}
              last
            />
          </Group>
          <View style={styles.row}>
            <Button
              label="Pair a real Mac"
              onPress={() => useLink.getState().leaveSample()}
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
        />
        <Toggle
          label={`Messages from ${chiefName(snapshot.entities)}`}
          value={synced.notifyZolt}
          disabled={!online || busy}
          onChange={(v) => void change("notifyZolt", v)}
          last
        />
      </Group>

      <Group>
        <Row
          title="Push permission"
          detail={push.label}
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
        <Row title="Models" onPress={() => router.push("/models")} />
        <Row title="Usage" onPress={() => router.push("/usage")} />
        <Row title="Connections" onPress={() => router.push("/connections")} last />
      </Group>

      <MacSettings />

      {devices.length ? <Section title={`Devices on ${macName || "your Mac"}`} /> : null}
      {devices.length ? (
        <Group>
          {devices.map((device, index) => {
            const self = device.id === deviceId;
            const name = text(device.name);
            return (
              <Row
                key={text(device.id)}
                title={name}
                detail={
                  self
                    ? `Paired ${since(device.pairedAt)}`
                    : `Last seen ${since(device.lastSeenAt)}`
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
      ) : null}

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
