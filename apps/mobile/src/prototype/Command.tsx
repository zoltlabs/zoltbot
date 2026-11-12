import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mono, touch, useTheme } from "../theme";
import { Button, Txt } from "../ui/kit";
import {
  type Agent,
  answerRequest,
  columns,
  type Initiative,
  marks,
  type Project,
  queue,
  sorted,
  updateAgent,
  waited,
  waiting,
} from "./model";
import { Request } from "./Request";
import { sampleProject, simulate, stressProject } from "./sample";

function Mark({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const { c } = useTheme();
  const mark = marks[agent.state];
  return (
    <View
      accessible
      accessibilityLabel={`${agent.id}, ${agent.provider}, ${mark.label}`}
      style={s.mark}
    >
      <View style={{ borderTopWidth: 3, borderColor: c[`provider-${agent.provider}`] }}>
        <Txt v="code" style={{ color: c[mark.tone] }}>
          {mark.shape} {agent.id.replace("unit-", "")}
        </Txt>
      </View>
      <Txt v="meta">{compact ? mark.label : `${agent.provider} · ${mark.label}`}</Txt>
    </View>
  );
}
function Progress({ initiative }: { initiative: Initiative }) {
  const { c } = useTheme();
  return (
    <View accessible accessibilityLabel={`${initiative.done} of ${initiative.total} tasks done`}>
      <View style={[s.track, { backgroundColor: c["bg-sunken"] }]}>
        <View
          style={{
            height: 4,
            width: `${(100 * initiative.done) / initiative.total}%`,
            backgroundColor: c["accent-text"],
          }}
        />
      </View>
      <Txt v="code">
        {initiative.done}/{initiative.total} tasks
      </Txt>
    </View>
  );
}
export function Command({
  initialLayout = "board",
  onClose,
}: {
  initialLayout?: "board" | "stacked";
  onClose?: () => void;
} = {}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const [project, setProject] = useState<Project>(() => sampleProject());
  const latestProject = useRef(project);
  latestProject.current = project;
  const [layout, setLayout] = useState<"board" | "stacked">(initialLayout);
  const [detailId, setDetail] = useState<string>();
  const [sheetId, setSheet] = useState<string>();
  const [chatId, setChat] = useState<string>();
  const [requestId, setRequest] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [order, setOrder] = useState("Report progress and the next risk.");
  const [running, setRunning] = useState(true);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const tick = useRef(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      const step = tick.current++;
      setProject((p) => simulate(p, step, Date.now()));
    }, 12000);
    return () => clearInterval(timer);
  }, [running]);
  const all = project.initiatives.flatMap((i) => i.agents);
  const detail = project.initiatives.find((i) => i.id === detailId);
  const sheet = all.find((a) => a.id === sheetId);
  const chat = all.find((a) => a.id === chatId);
  const pending = queue(project);
  const current = pending.find((e) => e.request.id === requestId);
  const oldest = pending[0];
  const openRequest = () => {
    if (oldest) {
      setSheet(undefined);
      setRequest(oldest.request.id);
    }
  };
  const applyOrder = (ids: string[], stop = false) => {
    if (!stop && !order.trim()) return;
    setProject((p) =>
      ids.reduce(
        (next, id) =>
          updateAgent(next, id, (a) => ({
            ...a,
            ...(stop
              ? { state: "idle" as const, request: undefined, activity: "Stopped by you" }
              : {}),
            messages: [
              ...a.messages,
              stop ? "Stop requested; sample agent stopped." : order.trim(),
            ],
          })),
        p,
      ),
    );
    setNotice(stop ? `${ids.length} agents stopped` : `Order sent to ${ids.length} agents`);
    setSelected([]);
  };
  const sendOrder = (ids: string[], stop = false) => {
    if (!stop) return applyOrder(ids);
    Alert.alert(
      `Stop ${ids.length === 1 ? "this agent" : `${ids.length} agents`}?`,
      "The selected agents stop now. Pending requests are cancelled in this sample.",
      [
        { text: "Keep running", style: "cancel" },
        { text: "Stop", style: "destructive", onPress: () => applyOrder(ids, true) },
      ],
    );
  };
  const reset = (size: "full" | "tiny" | "empty" | "forty") => {
    setProject(size === "forty" ? stressProject() : sampleProject(size));
    tick.current = 0;
    setDetail(undefined);
    setSelected([]);
    setNotice("");
  };
  const panel = { backgroundColor: c["bg-raised"], borderColor: c["border-control"] };
  const unblockButton = (
    <Button
      label={
        oldest
          ? `◆ Unblock ${pending.length} · oldest ${waited(oldest.request, now)}`
          : "No requests waiting"
      }
      disabled={!oldest}
      onPress={openRequest}
      kind="primary"
    />
  );
  return (
    <View style={[s.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <ScrollView
        key={requestId ?? chatId ?? detailId ?? "overview"}
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
      >
        <Txt v="largeTitle" accessibilityRole="header">
          {current ? "Needs you" : chat ? "Sample chat" : (detail?.name ?? "Project command")}
        </Txt>
        <Txt v="meta">Prototype · Local sample only</Txt>
        <View accessibilityLiveRegion="polite">
          <Txt>{notice}</Txt>
        </View>
        {current ? (
          <View key={current.request.id} style={[s.panel, panel]}>
            <Txt v="section">{current.agent.title}</Txt>
            <Txt v="code">Needs you · waiting {waited(current.request, now)}</Txt>
            <Request
              request={current.request}
              answer={(draft) => {
                const next = answerRequest(
                  latestProject.current,
                  current.request.id,
                  JSON.stringify(draft),
                );
                setProject(next);
                setRequest(queue(next)[0]?.request.id);
                setNotice("Answer recorded in sample");
              }}
            />
            <Txt v="meta">{pending.length} requests remaining</Txt>
            <Button label="Back to project" onPress={() => setRequest(undefined)} />
          </View>
        ) : chat ? (
          <>
            <Txt v="cardTitle">{chat.title}</Txt>
            <Mark agent={chat} />
            <Txt>{chat.result}</Txt>
            {chat.messages.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: sample messages are append-only
              <View key={`${index}-${message}`} style={[s.panel, panel]}>
                <Txt>{message}</Txt>
              </View>
            ))}
            <Txt v="section">Message</Txt>
            <TextInput
              accessibilityLabel="Message to sample agent"
              multiline
              value={order}
              onChangeText={setOrder}
              style={[s.input, panel, { color: c.text }]}
            />
            <Button
              label="Send message"
              disabled={!order.trim()}
              onPress={() => sendOrder([chat.id])}
            />
            <Button label="Back to project" onPress={() => setChat(undefined)} />
          </>
        ) : detail ? (
          <>
            <Txt>{detail.goal}</Txt>
            <Progress initiative={detail} />
            <Txt v="section" accessibilityRole="header">
              Last 24 hours
            </Txt>
            <Txt>{detail.changes}</Txt>
            <Txt v="section" accessibilityRole="header">
              Open pull requests
            </Txt>
            {detail.prs.map((pr) => (
              <Txt key={pr} v="code">
                {pr}
              </Txt>
            ))}
            <Txt v="section" accessibilityRole="header">
              Required checks
            </Txt>
            <Txt>
              {detail.checks.length ? detail.checks.join(" · ") : "No failing required checks"}
            </Txt>
            {detail.agents.map((agent) => (
              <View key={agent.id} style={[s.panel, panel]}>
                <Mark agent={agent} />
                <Txt v="section">{agent.title}</Txt>
                <Txt>{agent.activity}</Txt>
                {agent.request ? <Txt>Needs you · waiting {waited(agent.request, now)}</Txt> : null}
                <View style={s.actions}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Select ${agent.title}`}
                    accessibilityState={{ checked: selected.includes(agent.id) }}
                    onPress={() =>
                      setSelected((ids) =>
                        ids.includes(agent.id)
                          ? ids.filter((id) => id !== agent.id)
                          : [...ids, agent.id],
                      )
                    }
                    style={[s.select, panel]}
                  >
                    <Txt>{selected.includes(agent.id) ? "☑ Selected" : "☐ Select"}</Txt>
                  </Pressable>
                  <Button label="Agent details" onPress={() => setSheet(agent.id)} />
                </View>
              </View>
            ))}
            <View style={[s.panel, panel]}>
              <Txt v="section" accessibilityRole="header">
                Orders · {selected.length} selected
              </Txt>
              <View style={s.actions}>
                <Button
                  label="Report progress"
                  onPress={() => setOrder("Report progress and the next risk.")}
                />
                <Button
                  label="Focus on checks"
                  onPress={() => setOrder("Fix failing required checks before new work.")}
                />
              </View>
              <Txt>Order</Txt>
              <TextInput
                accessibilityLabel="Order for selected agents"
                multiline
                value={order}
                onChangeText={setOrder}
                style={[s.input, panel, { color: c.text }]}
              />
              <Button
                label="Send order"
                disabled={!selected.length || !order.trim()}
                onPress={() => sendOrder(selected)}
              />
              <Button
                label="Stop selected agents"
                disabled={!selected.length}
                onPress={() => sendOrder(selected, true)}
              />
            </View>
            <Button
              label="Back to project"
              onPress={() => {
                setDetail(undefined);
                setSelected([]);
              }}
            />
          </>
        ) : (
          <>
            <Txt v="cardTitle">{project.name}</Txt>
            <Txt v="code">
              {all.filter((a) => a.state === "working").length} working · {pending.length} waiting ·
              ${project.spend.toFixed(2)} today ·{" "}
              {project.initiatives.reduce((n, i) => n + i.checks.length, 0)} failing checks
            </Txt>
            <View style={s.grid}>
              {sorted(project).map((initiative) => (
                <Pressable
                  key={initiative.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${initiative.name}. ${initiative.goal} ${initiative.done} of ${initiative.total} tasks done. ${waiting(initiative)} need you. ${initiative.agents.map((a) => `${a.id}, ${a.provider}, ${marks[a.state].label}`).join(". ")}. Open initiative.`}
                  onPress={() => {
                    setDetail(initiative.id);
                    setSelected([]);
                  }}
                  style={[
                    s.tile,
                    panel,
                    {
                      width: columns(fontScale, layout) === 2 ? "48%" : "100%",
                      borderColor: waiting(initiative) ? c.attention : c["border-control"],
                    },
                  ]}
                >
                  <Txt v="section" accessibilityRole="header">
                    {initiative.name}
                  </Txt>
                  <Txt v="meta">{initiative.goal}</Txt>
                  <Progress initiative={initiative} />
                  <View style={s.marks}>
                    {initiative.agents.map((agent) => (
                      <Mark key={agent.id} agent={agent} compact />
                    ))}
                  </View>
                  <Txt v="meta" style={{ color: waiting(initiative) ? c.attention : c.text }}>
                    {waiting(initiative)
                      ? `◆ ${waiting(initiative)} need you`
                      : "No requests waiting"}
                  </Txt>
                </Pressable>
              ))}
            </View>
            {!project.initiatives.length ? (
              <Txt>No initiatives yet. Choose the full sample below to explore a project.</Txt>
            ) : null}
            <Txt v="meta">
              ⬡ Working · ◆ Needs you · ⚑ Done, unread · ▬ Idle / Later · ▲ Warning
            </Txt>
            <Button
              label={layout === "board" ? "Try stacked sections" : "Try compact board"}
              onPress={() => setLayout(layout === "board" ? "stacked" : "board")}
            />
            <View style={s.actions}>
              <Button label="Full sample" onPress={() => reset("full")} />
              <Button label="40-agent sample" onPress={() => reset("forty")} />
              <Button label="Tiny sample" onPress={() => reset("tiny")} />
              <Button label="Empty sample" onPress={() => reset("empty")} />
            </View>
          </>
        )}
        <Button
          label={running ? "Pause live sample" : "Resume live sample"}
          onPress={() => setRunning(!running)}
        />
      </ScrollView>
      <View style={[s.footer, { paddingBottom: insets.bottom + 8 }]}>
        {!current ? unblockButton : null}
        {onClose ? <Button label="Close prototype" onPress={onClose} /> : null}
      </View>
      <Modal
        visible={!!sheet}
        transparent
        animationType="none"
        onRequestClose={() => setSheet(undefined)}
      >
        <View style={s.overlay}>
          <View
            accessibilityViewIsModal
            style={[s.sheet, panel, { paddingBottom: insets.bottom + 16 }]}
          >
            <ScrollView contentContainerStyle={s.body}>
              {sheet ? (
                <>
                  <Txt v="cardTitle" accessibilityRole="header">
                    {sheet.title}
                  </Txt>
                  <Mark agent={sheet} />
                  <Txt>{sheet.activity}</Txt>
                  {sheet.request ? <Txt>Waiting {waited(sheet.request, now)}</Txt> : null}
                  <Txt v="section">Last result</Txt>
                  <Txt>{sheet.result}</Txt>
                  <Txt>
                    {project.initiatives.find((i) => i.agents.some((a) => a.id === sheet.id))?.name}
                  </Txt>
                  <Button
                    label="Answer request"
                    disabled={!sheet.request}
                    onPress={() => {
                      setSheet(undefined);
                      setRequest(sheet.request?.id);
                    }}
                  />
                  <Button
                    label="Send a message"
                    onPress={() => {
                      setSheet(undefined);
                      setChat(sheet.id);
                    }}
                  />
                  <Button label="Stop agent" onPress={() => sendOrder([sheet.id], true)} />
                  <Button
                    label="Open chat"
                    onPress={() => {
                      setSheet(undefined);
                      setChat(sheet.id);
                    }}
                  />
                  {unblockButton}
                </>
              ) : null}
              <Button label="Close agent details" onPress={() => setSheet(undefined)} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
const s = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 12, gap: 8 },
  panel: { padding: 12, borderWidth: 1, gap: 8 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 },
  tile: { minHeight: touch, padding: 8, borderWidth: 1, gap: 4 },
  marks: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  mark: { gap: 4 },
  track: { height: 4, marginVertical: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  input: { fontFamily: mono, fontSize: 15, minHeight: touch, padding: 12, borderWidth: 1 },
  select: {
    minHeight: touch,
    minWidth: touch,
    padding: 12,
    borderWidth: 1,
    justifyContent: "center",
  },
  footer: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  overlay: { flex: 1, justifyContent: "flex-end" },
  sheet: { maxHeight: "85%", borderWidth: 1 },
});
