import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Row as Entity } from "../data/transport";
import {
  formatCost,
  formatTokens,
  type UsageRange,
  type UsageSort,
  usageByChat,
  usageFrom,
} from "../data/usage";
import { useClient, useLink, useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Group, Row, Segmented, Txt } from "../ui/kit";

const RANGES: { value: UsageRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];
const SORTS: { value: UsageSort; label: string }[] = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
];

/** S6: spend and tokens by chat for a range, as on the Mac's Usage page, without the chart. */
export default function Usage() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const [range, setRange] = useState<UsageRange>("7d");
  const [sort, setSort] = useState<UsageSort>("cost");
  const [records, setRecords] = useState<Entity[]>();
  const [error, setError] = useState("");

  // Only the latest request's answer is shown, so a slow answer for another range can't land.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    const request = ++latest.current;
    setRecords(undefined);
    try {
      const from = usageFrom(range, new Date()).toISOString();
      const result = await client.call("usage.query", { from }, `usage-${request}-${Date.now()}`);
      if (request !== latest.current) return;
      setRecords(Array.isArray(result) ? (result as Entity[]) : []);
      setError("");
    } catch {
      if (request === latest.current) setError("Couldn’t load usage. Try again in a moment.");
    }
  }, [range]);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);

  const rows = useMemo(
    () => (records ? usageByChat(records, snapshot.entities, sort) : []),
    [records, snapshot.entities, sort],
  );
  const total = rows.reduce(
    (sum, row) => ({
      cost: sum.cost + row.costUsd,
      known: sum.known && row.costKnown,
      tokens: sum.tokens + row.tokens,
    }),
    { cost: 0, known: true, tokens: 0 },
  );

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Settings" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Usage
        </Txt>
        <OfflineBanner />
        <Segmented<UsageRange> label="Range" value={range} onChange={setRange} options={RANGES} />
        {error ? (
          <View accessibilityLiveRegion="polite">
            <Txt tone="danger">{error}</Txt>
          </View>
        ) : null}
        {records && rows.length === 0 && !error ? (
          <Txt tone="muted">No usage in this range.</Txt>
        ) : null}
        {rows.length ? (
          <>
            <View style={styles.totals}>
              <View>
                <Txt v="meta" tone="muted">
                  Cost
                </Txt>
                <Txt v="cardTitle">{formatCost(total.cost, total.known)}</Txt>
              </View>
              <View>
                <Txt v="meta" tone="muted">
                  Tokens
                </Txt>
                <Txt v="cardTitle">{formatTokens(total.tokens)}</Txt>
              </View>
            </View>
            <Segmented<UsageSort> label="Sort by" value={sort} onChange={setSort} options={SORTS} />
            <Group>
              {rows.map((row, index) => (
                <Row
                  key={row.threadId || `deleted-${index}`}
                  title={row.name || "Deleted chat"}
                  detail={`${formatCost(row.costUsd, row.costKnown)} · ${formatTokens(row.tokens)} tokens`}
                  label={`${row.name || "Deleted chat"}, ${formatCost(row.costUsd, row.costKnown)}, ${formatTokens(row.tokens)} tokens`}
                  last={index === rows.length - 1}
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
  totals: { flexDirection: "row", gap: 32 },
});
