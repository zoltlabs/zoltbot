import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import type { SavedMac } from "../data/macs";
import { needsYou, since } from "../data/view";
import { useLink } from "../state/link";
import { touch, useTheme } from "../theme";
import { Icon } from "./icons";
import {
  Button,
  Chip,
  Group,
  Row,
  Section,
  showConfirmSheet,
  showMenu,
  showPrompt,
  Txt,
} from "./kit";

// P1: a phone paired with several Macs. Settings lists them with Rename and Forget; the drawer
// header switches between them and shows what needs the owner on the Macs not shown.

interface MacStatus {
  online: boolean;
  needs: number;
}

/** Each paired Mac's link status and Needs you count, kept current. */
export function useMacStatus(): Record<string, MacStatus> {
  const clients = useLink((state) => state.clients);
  const [status, setStatus] = useState<Record<string, MacStatus>>({});
  useEffect(() => {
    const read = () =>
      setStatus(
        Object.fromEntries(
          Object.entries(clients).map(([macId, client]) => {
            const state = client.getState();
            return [
              macId,
              { online: state.status === "online", needs: needsYou(state.snapshot).length },
            ];
          }),
        ),
      );
    read();
    const stops = Object.values(clients).map((client) =>
      client.subscribe((state, before) => {
        if (state.snapshot !== before.snapshot || state.status !== before.status) read();
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [clients]);
  return status;
}

const pairAnother = () => router.push("/pair");

function rename(mac: SavedMac) {
  showPrompt({
    title: "Rename",
    defaultValue: mac.label,
    confirmLabel: "Rename",
    onSubmit: (label) => void useLink.getState().rename(mac.macId, label),
  });
}
function forget(mac: SavedMac) {
  showConfirmSheet({
    title: `Forget ${mac.label}?`,
    body: `You'll need to pair again to use ${mac.label}.`,
    confirmLabel: "Forget",
    onConfirm: () =>
      void useLink
        .getState()
        .forget(mac.macId)
        .catch(() => Alert.alert(`${mac.label} wasn't forgotten`, "Try again.")),
  });
}

/** Settings › Macs. */
export function MacSettings() {
  const { c } = useTheme();
  const { macs, activeId, fake } = useLink();
  const status = useMacStatus();
  if (!macs.length) return null;
  return (
    <>
      <Section title="Macs" />
      <Group>
        {macs.map((mac, index) => {
          const active = mac.macId === activeId;
          const online = status[mac.macId]?.online ?? false;
          // One chip says both: the name keeps the room at large text sizes.
          const state = online
            ? "Connected"
            : mac.lastSeenAt
              ? `Seen ${since(mac.lastSeenAt)}`
              : "Offline";
          return (
            <Row
              key={mac.macId}
              title={mac.label}
              label={[
                mac.label,
                active ? "shown" : "",
                online ? "Connected" : "Offline",
                !online && mac.lastSeenAt ? `last seen ${since(mac.lastSeenAt)}` : "",
              ]
                .filter(Boolean)
                .join(", ")}
              left={
                <View style={styles.mark}>
                  {active ? <Icon name="check" size={18} color={c["accent-text"]} /> : null}
                </View>
              }
              right={<Chip label={state} tone={online ? "ok" : "neutral"} dot />}
              onPress={() =>
                showMenu(
                  [
                    ...(active
                      ? []
                      : [
                          {
                            label: "Switch to this Mac",
                            onPress: () => useLink.getState().switchTo(mac.macId),
                          },
                        ]),
                    { label: "Rename", onPress: () => rename(mac) },
                    { label: "Forget", destructive: true, onPress: () => forget(mac) },
                  ],
                  mac.label,
                )
              }
              last={index === macs.length - 1}
            />
          );
        })}
      </Group>
      {fake ? null : <Button label="Pair another Mac" onPress={pairAnother} />}
    </>
  );
}

/** The drawer's first row: the Mac shown, with what needs the owner on the others. */
export function MacSwitcher({ onLeave }: { onLeave: () => void }) {
  const { c } = useTheme();
  const { macs, activeId, macName, fake } = useLink();
  const status = useMacStatus();
  if (!macs.length) return null;
  const others = macs.filter((mac) => mac.macId !== activeId);
  const elsewhere = others.reduce((sum, mac) => sum + (status[mac.macId]?.needs ?? 0), 0);
  const online = activeId ? (status[activeId]?.online ?? false) : false;
  const open = () =>
    showMenu(
      [
        ...others.map((mac) => {
          const needs = status[mac.macId]?.needs ?? 0;
          return {
            label: needs ? `${mac.label} (${needs})` : mac.label,
            onPress: () => useLink.getState().switchTo(mac.macId),
          };
        }),
        ...(fake
          ? []
          : [
              {
                label: "Pair another Mac",
                onPress: () => {
                  onLeave();
                  pairAnother();
                },
              },
            ]),
      ],
      "Macs",
    );
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={[
        `${macName}, switch Mac`,
        elsewhere ? `${elsewhere} need you on other Macs` : "",
      ]
        .filter(Boolean)
        .join(", ")}
      style={({ pressed }) => [styles.switcher, pressed && { backgroundColor: c["bg-active"] }]}
    >
      <View style={[styles.dot, { backgroundColor: online ? c.ok : c["text-muted"] }]} />
      <Txt v="meta" tone="secondary" lines={1} style={styles.shrink}>
        {macName}
      </Txt>
      {elsewhere ? (
        <View style={[styles.badge, { backgroundColor: c.attention }]}>
          <Txt v="chip" style={{ color: c["bg-page"] }}>
            {String(elsewhere)}
          </Txt>
        </View>
      ) : null}
      <Icon name="down" size={14} color={c["text-muted"]} stroke={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  mark: { width: 18, alignItems: "center" },
  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: touch,
    alignSelf: "flex-start",
    // Lines its dot up with the drawer header's 16pt edge.
    marginHorizontal: 12,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
  shrink: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});
