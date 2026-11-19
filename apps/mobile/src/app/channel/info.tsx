import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import {
  actionLabels,
  type ChannelRequestView,
  groupRequests,
  requestActions,
  requestMeta,
} from "../../data/channels";
import { useChannel } from "../../state/channel";
import { useTheme } from "../../theme";
import { BotAvatar } from "../../ui/BotAvatar";
import { HeaderButton, LeadBadge, PillButton, RequestDot } from "../../ui/channel/ChannelParts";
import { OfflineBanner } from "../../ui/chrome";
import { Icon } from "../../ui/icons";
import { Group, Txt } from "../../ui/kit";

/** The channel sheet: its requests, with what can be done to each, and its members. */
export default function ChannelInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const channel = useChannel(id);
  const { view } = channel;
  const groups = groupRequests(view?.requests ?? []);
  const row = (request: ChannelRequestView, last: boolean) => (
    <RequestRow
      key={request.id}
      request={request}
      memberCount={view?.members.length ?? 0}
      last={last}
      disabled={!channel.online || channel.acting === request.id}
      onAction={(action) => channel.perform(request, action)}
    />
  );
  const section = (title: string, requests: ChannelRequestView[]) =>
    requests.length ? (
      <View style={styles.section}>
        <Txt v="chip" tone="muted" accessibilityRole="header" style={styles.heading}>
          {title}
        </Txt>
        <Group>
          {requests.map((request, index) => row(request, index === requests.length - 1))}
        </Group>
      </View>
    ) : null;

  return (
    <ScrollView
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <View style={styles.spacer} />
        <Txt v="cardTitle" accessibilityRole="header" lines={1} style={styles.title}>
          {view ? `#${view.name}` : ""}
        </Txt>
        <HeaderButton label="Close" onPress={() => router.back()}>
          <Icon name="close" color={c.text} size={16} stroke={2} />
        </HeaderButton>
      </View>
      <OfflineBanner />
      {view ? (
        <>
          {section("Open requests", groups.open)}
          {section("Done", groups.done)}
          {section("Archived", groups.archived)}
          {view.requests.length === 0 ? (
            <Txt tone="muted" style={styles.empty}>
              No requests yet.
            </Txt>
          ) : null}
          <View style={styles.section}>
            <Txt v="chip" tone="muted" accessibilityRole="header" style={styles.heading}>
              Members
            </Txt>
            <Group>
              {view.members.map((member, index) => (
                <View
                  key={member.threadId}
                  accessible
                  accessibilityLabel={member.lead ? `${member.name}, lead` : member.name}
                  style={[
                    styles.row,
                    index < view.members.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: c.border,
                    },
                  ]}
                >
                  <BotAvatar id={member.threadId} size={28} />
                  <Txt style={styles.grow}>{member.name}</Txt>
                  {member.lead ? <LeadBadge /> : null}
                </View>
              ))}
            </Group>
          </View>
        </>
      ) : channel.failed ? (
        <Txt tone="secondary" style={styles.empty}>
          {channel.failed}
        </Txt>
      ) : (
        <ActivityIndicator color={c["text-muted"]} accessibilityLabel="Loading" />
      )}
    </ScrollView>
  );
}

function RequestRow({
  request,
  memberCount,
  last,
  disabled,
  onAction,
}: {
  request: ChannelRequestView;
  memberCount: number;
  last: boolean;
  disabled: boolean;
  onAction: (action: ReturnType<typeof requestActions>[number]) => void;
}) {
  const { c } = useTheme();
  const actions = requestActions(request, memberCount);
  const meta = requestMeta(request);
  const buttons = actions.map((action) => (
    <PillButton
      key={action}
      label={actionLabels[action]}
      a11y={`${actionLabels[action]} ${request.title}`}
      disabled={disabled}
      onPress={() => onAction(action)}
    />
  ));
  // One action sits beside the title; several go on their own line under it.
  const inline = actions.length === 1;
  return (
    <View
      style={[
        styles.request,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
      ]}
    >
      <View style={styles.requestTop}>
        <View style={styles.dot}>
          <RequestDot state={request.state} />
        </View>
        <View style={styles.grow} accessible accessibilityLabel={`${request.title}, ${meta}`}>
          <Txt v="bodyMedium">{request.title}</Txt>
          <Txt v="meta" tone="muted">
            {meta}
          </Txt>
        </View>
        {inline ? buttons : null}
      </View>
      {inline ? null : <View style={styles.actions}>{buttons}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, gap: 4 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  spacer: { width: 44 },
  title: { flex: 1, textAlign: "center" },
  section: { marginTop: 16, gap: 8 },
  heading: { marginHorizontal: 4 },
  empty: { textAlign: "center", marginTop: 24 },
  grow: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  request: { paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  requestTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  dot: { paddingTop: 7 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 18 },
});
