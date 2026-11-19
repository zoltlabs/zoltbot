import { TASK_RUNNING_LIMIT_SETTING } from "@zoltbot/protocol";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type AccountView,
  accountViews,
  type BackupEntry,
  type BackupOrders,
  type BackupRole,
  moveEntry,
  orderFor,
  RUNNING_LIMIT,
  runningLimit,
  toOrders,
} from "../data/backup-models";
import type { Row as Entity } from "../data/transport";
import { useAction } from "../state/actions";
import { useClient, useLink, useSnapshot } from "../state/link";
import { touch, useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Icon } from "../ui/icons";
import { Stepper } from "../ui/interactions/controls";
import { Button, Group, Row, Section, Segmented, Txt } from "../ui/kit";
import { pick } from "../ui/SessionControls";

const ROLES: { value: BackupRole; label: string }[] = [
  { value: "ceo", label: "CEO" },
  { value: "manager", label: "Managers" },
  { value: "employee", label: "Employees" },
];
const MAX_ENTRIES = 8;

function useModels(online: boolean) {
  const definitions = useSnapshot().entities.agentDefinition;
  const [items, setItems] = useState<Entity[]>();
  const [orders, setOrders] = useState<BackupOrders>();
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const client = useLink.getState().client?.getState();
    if (!client) return;
    try {
      const result = (await client.call("modelAccount.list", {})) as Entity;
      setItems(Array.isArray(result.items) ? (result.items as Entity[]) : []);
      setOrders(toOrders(result.orders));
      setError("");
    } catch {
      setError("Models could not be loaded.");
    }
  }, []);
  useEffect(() => {
    if (online) void load();
  }, [online, load]);
  const accounts = items ? accountViews(items, definitions ?? []) : undefined;
  return { accounts, orders, setOrders, error, reload: load };
}

function AccountDot({ state }: { state: AccountView["state"] }) {
  const { c } = useTheme();
  const color = state === "limit" ? c.warn : state === "ready" ? c.ok : c["text-dim"];
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

/**
 * Accounts and the backup order each role falls back through when an account hits its limit,
 * plus how many tasks each employee runs at once. Accounts are added on the Mac.
 */
export default function Models() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const { accounts, orders, setOrders, error, reload } = useModels(online);
  const [role, setRole] = useState<BackupRole>("employee");
  const stored = runningLimit(snapshot);
  const [limit, setLimit] = useState(stored);
  useEffect(() => setLimit(stored), [stored]);
  const locked = !online || busy;

  const own = orders ? orders[role] : null;
  const shared = role !== "employee" && own === null;
  const order = orders ? orderFor(orders, role) : [];
  const byId = (id: string) => accounts?.find((account) => account.id === id);
  const unlisted = (accounts ?? []).filter(
    (account) => !order.some((entry) => entry.accountId === account.id),
  );
  const roleName = ROLES.find((item) => item.value === role)?.label ?? "";

  const save = async (entries: BackupEntry[] | null) => {
    const result = await run("backupOrder.set", { role, entries });
    if (result) setOrders(toOrders(result));
    else void reload();
  };
  const entryName = (entry: BackupEntry) => byId(entry.accountId)?.name ?? "Removed account";
  const arrange = (index: number) => {
    const entry = order[index];
    if (!entry) return;
    const options = [
      ...(index > 0 ? [{ label: "Move up", run: () => save(moveEntry(order, index, -1)) }] : []),
      ...(index < order.length - 1
        ? [{ label: "Move down", run: () => save(moveEntry(order, index, 1)) }]
        : []),
      { label: "Remove", run: () => save(order.filter((_, at) => at !== index)) },
    ];
    pick(
      entryName(entry),
      undefined,
      options.map((option) => option.label),
      (choice) => void options[choice]?.run(),
    );
  };
  const addBackup = () =>
    pick(
      "Add backup",
      undefined,
      unlisted.map((account) => account.name),
      (index) => {
        const account = unlisted[index];
        if (account) void save([...order, { accountId: account.id }]);
      },
    );
  const changeLimit = (next: number) => {
    setLimit(next);
    void run(
      "settings.set",
      { key: TASK_RUNNING_LIMIT_SETTING, value: next },
      { key: `running-limit:${next}` },
    ).then((result) => {
      if (!result) setLimit(stored);
    });
  };

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Settings" />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        <Txt v="largeTitle" accessibilityRole="header">
          Models
        </Txt>
        <OfflineBanner />
        {error ? (
          <View style={styles.error}>
            <Txt tone="danger">{error}</Txt>
            <Button label="Try again" disabled={!online} onPress={() => void reload()} />
          </View>
        ) : null}

        <Section title="Accounts" />
        {!accounts ? (
          <Txt tone="muted">{online ? "Loading…" : "Models load when your Mac is online."}</Txt>
        ) : (
          <Group>
            {accounts.map((account, index) => (
              <Row
                key={account.id}
                title={account.name}
                {...(account.status ? { meta: account.status } : {})}
                left={<AccountDot state={account.state} />}
                last={index === accounts.length - 1}
              />
            ))}
          </Group>
        )}
        <Txt v="meta" tone="muted" style={styles.foot}>
          Add accounts on your Mac.
        </Txt>

        <Section title="Backup order" />
        <Segmented<BackupRole>
          label="Backup order for"
          value={role}
          onChange={setRole}
          options={ROLES}
        />
        {!orders ? null : shared ? (
          <View style={styles.shared}>
            <Txt tone="muted">{`${roleName} use the employees’ order.`}</Txt>
            <Button
              label="Use own order"
              disabled={locked}
              onPress={() => void save([...orders.employee])}
            />
          </View>
        ) : (
          <>
            <Group>
              {order.map((entry, index) => {
                const name = entryName(entry);
                const model = entry.model ?? "Default model";
                return (
                  <Row
                    key={`${entry.accountId}:${entry.model ?? ""}`}
                    title={model}
                    meta={name}
                    left={
                      <View style={[styles.num, { backgroundColor: c["bg-sunken"] }]}>
                        <Txt v="chip">{String(index + 1)}</Txt>
                      </View>
                    }
                    right={
                      <Pressable
                        onPress={() => arrange(index)}
                        disabled={locked}
                        accessibilityRole="button"
                        accessibilityLabel={`Reorder ${model}, ${name}`}
                        accessibilityActions={[
                          ...(index > 0 ? [{ name: "moveUp", label: "Move up" }] : []),
                          ...(index < order.length - 1
                            ? [{ name: "moveDown", label: "Move down" }]
                            : []),
                        ]}
                        onAccessibilityAction={(event) =>
                          void save(
                            moveEntry(
                              order,
                              index,
                              event.nativeEvent.actionName === "moveUp" ? -1 : 1,
                            ),
                          )
                        }
                        style={[styles.grip, locked && { opacity: 0.5 }]}
                      >
                        <Icon name="grip" size={18} stroke={2.6} color={c["text-muted"]} />
                      </Pressable>
                    }
                  />
                );
              })}
              {unlisted.length && order.length < MAX_ENTRIES ? (
                <Pressable
                  onPress={addBackup}
                  disabled={locked}
                  accessibilityRole="button"
                  accessibilityLabel="Add backup"
                  style={({ pressed }) => [
                    styles.add,
                    pressed && { backgroundColor: c["bg-active"] },
                    locked && { opacity: 0.5 },
                  ]}
                >
                  <Icon name="plus" size={18} stroke={2} color={c["accent-text"]} />
                  <Txt tone="accent">Add backup</Txt>
                </Pressable>
              ) : null}
            </Group>
            {!order.length ? (
              <Txt v="meta" tone="muted" style={styles.foot}>
                No backups. Chats wait when their account hits its limit.
              </Txt>
            ) : null}
            {role !== "employee" ? (
              <Button
                kind="plain"
                label="Use employees’ order"
                disabled={locked}
                onPress={() => void save(null)}
              />
            ) : null}
          </>
        )}

        <View style={styles.gap} />
        <Group>
          <Row
            title="Parallel tasks per employee"
            titleLines={2}
            right={
              <Stepper
                label="Parallel tasks per employee"
                value={limit}
                min={RUNNING_LIMIT.min}
                max={RUNNING_LIMIT.max}
                onChange={changeLimit}
                disabled={locked}
              />
            }
            last
          />
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 10 },
  foot: { marginHorizontal: 4 },
  error: { gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  num: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  grip: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  add: {
    minHeight: touch + 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
  },
  shared: { gap: 8 },
  gap: { height: 12 },
});
