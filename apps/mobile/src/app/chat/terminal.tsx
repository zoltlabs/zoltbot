import type { TerminalInfo, TerminalOutput } from "@zoltbot/protocol";
import { useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { writeError } from "../../data/manage";
import { appendOutput, interruptKey } from "../../data/terminal";
import { newId, useAction } from "../../state/actions";
import { useClient, useLink } from "../../state/link";
import { mono, type as typography, useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Chip, Group, Row, Txt } from "../../ui/kit";

type Listed = TerminalInfo & { owned: boolean };
const call = (method: string, params: unknown) =>
  useLink.getState().client?.getState().call(method, params) ??
  Promise.reject(new Error("Not connected to your Mac."));
const items = (value: unknown) => ((value ?? {}) as { items?: TerminalInfo[] }).items ?? [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows a chat's terminal output. Terminals another device opened are view only (D-6); one
 * this phone owns can also be interrupted. After a dropped connection it attaches again and
 * continues from the last offset, so no output is lost while the Mac still holds it.
 */
export default function Terminal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const [terminals, setTerminals] = useState<Listed[]>();
  const [chosen, setChosen] = useState("");
  const [shown, setShown] = useState("");
  const [info, setInfo] = useState<TerminalInfo>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const offset = useRef(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    if (!online) return;
    let live = true;
    Promise.all([
      call("terminal.list", { threadId: id }),
      call("terminal.list", { threadId: id, readOnly: true }),
    ])
      .then(([mine, all]) => {
        if (!live) return;
        const owned = new Set(items(mine).map((row) => row.id));
        const rows = items(all).map((row) => ({ ...row, owned: owned.has(row.id) }));
        setTerminals(rows);
        setChosen(
          (now) => now || (rows.find((row) => row.status === "running") ?? rows[0])?.id || "",
        );
      })
      .catch(() => live && setError("Terminals could not be loaded."));
    return () => {
      live = false;
    };
  }, [id, online]);

  const terminal = terminals?.find((row) => row.id === chosen);
  const owned = !!terminal?.owned;
  useEffect(() => {
    if (!online || !chosen) return;
    let live = true;
    let attachmentId = "";
    let attached = false;
    const scope = { threadId: id, id: chosen };
    void (async () => {
      while (live) {
        try {
          if (!attachmentId) {
            const result = (await call("terminal.attach", {
              ...scope,
              ...(owned ? {} : { readOnly: true }),
            })) as { attachmentId: string };
            attachmentId = result.attachmentId;
            if (attached) setNote("Reconnected");
            attached = true;
          }
          const out = (await call("terminal.read", {
            ...scope,
            attachmentId,
            offset: offset.current,
          })) as TerminalOutput;
          if (!live) break;
          if (out.truncated)
            setShown((now) => appendOutput(now, "\n… earlier output was trimmed\n"));
          offset.current = out.offset;
          if (out.data) setShown((now) => appendOutput(now, out.data));
          setInfo(out.terminal);
          setError("");
          if (out.terminal.status === "exited" && out.caughtUp) break;
        } catch (cause) {
          if (!live) break;
          // The attachment expires with the connection; attach again and resume from the offset.
          attachmentId = "";
          const code = cause instanceof Error ? cause.message : "";
          if (/terminal_unavailable|terminal_workspace_changed/.test(code)) {
            setError("This terminal is no longer available.");
            break;
          }
          await wait(2000);
        }
      }
    })();
    return () => {
      live = false;
      if (attachmentId)
        void call("terminal.detach", { ...scope, attachmentId }).catch(() => undefined);
    };
  }, [id, chosen, owned, online]);

  const pickTerminal = (next: string) => {
    if (next === chosen) return;
    offset.current = 0;
    setShown("");
    setInfo(undefined);
    setNote("");
    setChosen(next);
  };
  const interrupt = () =>
    void run(
      "terminal.input",
      { threadId: id, id: chosen, data: interruptKey },
      { key: newId("interrupt"), quiet: true },
    ).catch((cause: unknown) => setError(writeError(cause)));

  const status = info ?? terminal;
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar
        label="the chat"
        right={
          owned && status?.status === "running" ? (
            <Button
              kind="plain"
              label="Interrupt"
              a11y="Send Control-C"
              disabled={!online || busy}
              onPress={interrupt}
            />
          ) : undefined
        }
      />
      <View style={styles.head}>
        <Txt v="largeTitle" accessibilityRole="header">
          Terminal
        </Txt>
        {status ? (
          <Chip
            label={
              status.status === "exited"
                ? `Exited${status.exitCode === undefined ? "" : ` ${status.exitCode}`}`
                : owned
                  ? "Running"
                  : "View only"
            }
            tone={status.status === "running" ? "ok" : "neutral"}
            dot
          />
        ) : null}
      </View>
      <View style={styles.meta}>
        <OfflineBanner />
        {status ? (
          <Txt v="meta" tone="muted" lines={1} style={{ fontFamily: mono }}>
            {status.cwd}
          </Txt>
        ) : null}
        {note ? (
          <View accessibilityLiveRegion="polite">
            <Txt v="meta" tone="muted">
              {note}
            </Txt>
          </View>
        ) : null}
        {error ? <Txt tone="danger">{error}</Txt> : null}
        {terminals && terminals.length > 1 ? (
          <Group>
            {terminals.map((row, index) => (
              <Row
                key={row.id}
                title={`Terminal ${index + 1}`}
                meta={`${row.owned ? "This iPhone" : "Your Mac"} · ${row.status}`}
                checked={row.id === chosen}
                onPress={() => pickTerminal(row.id)}
                last={index === terminals.length - 1}
              />
            ))}
          </Group>
        ) : null}
        {terminals && !terminals.length ? (
          <Txt tone="muted">No terminal is open in this chat.</Txt>
        ) : null}
      </View>
      <ScrollView
        ref={scroll}
        style={[styles.screen, { backgroundColor: c["bg-raised"], borderColor: c.border }]}
        contentContainerStyle={styles.screenBody}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        accessibilityLabel="Terminal output"
      >
        <Text selectable style={[typography.meta, { fontFamily: mono, color: c.text }]}>
          {shown || (chosen ? "Waiting for output…" : "")}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 },
  meta: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  screen: {
    flex: 1,
    margin: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  screenBody: { padding: 12 },
});
