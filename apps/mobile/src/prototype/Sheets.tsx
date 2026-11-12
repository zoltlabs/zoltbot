import type { ReactNode } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Txt } from "../ui/kit";
import { OrderButton } from "./controls";
import { AgentIdentity } from "./Detail";
import { type Agent, waited } from "./model";

export function Sheet({
  visible,
  close,
  children,
  title,
}: {
  visible: boolean;
  close: () => void;
  children: ReactNode;
  title: string;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      <View style={[s.overlay, { backgroundColor: c.scrim }]}>
        <View
          accessibilityViewIsModal
          style={[
            s.sheet,
            {
              backgroundColor: c["bg-page"],
              borderColor: c["border-control"],
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
            <View style={s.heading}>
              <Txt v="cardTitle" accessibilityRole="header">
                {title}
              </Txt>
            </View>
            {children}
            <OrderButton
              label={title === "Prototype" ? "Done" : `Close ${title.toLowerCase()}`}
              onPress={close}
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
export function AgentSheet({
  agent,
  initiativeName,
  now,
  close,
  answer,
  message,
  stop,
  unblock,
  openInitiative,
}: {
  agent?: Agent;
  initiativeName?: string;
  now: number;
  close: () => void;
  answer: () => void;
  message: () => void;
  stop: () => void;
  unblock: ReactNode;
  openInitiative: () => void;
}) {
  return (
    <Sheet visible={!!agent} close={close} title="Agent details">
      {agent ? (
        <>
          <AgentIdentity agent={agent} />
          <Txt>{agent.activity}</Txt>
          {agent.request ? (
            <Txt v="code" tone="attention">
              Waiting {waited(agent.request, now)}
            </Txt>
          ) : null}
          <Txt v="section" accessibilityRole="header">
            Last result
          </Txt>
          <Txt tone="secondary">{agent.result}</Txt>
          <OrderButton label={initiativeName ?? "Open initiative"} onPress={openInitiative} />
          {agent.request ? <OrderButton label="Answer request" attention onPress={answer} /> : null}
          <View style={s.actions}>
            <OrderButton label="Send a message" onPress={message} />
            <OrderButton label="Stop agent" onPress={stop} />
            <OrderButton label="Open chat" onPress={message} />
          </View>
          {unblock}
        </>
      ) : null}
    </Sheet>
  );
}
const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  sheet: { maxHeight: "90%", borderTopWidth: 1 },
  body: { padding: 16, gap: 12 },
  heading: { paddingBottom: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
