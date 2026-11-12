import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { answerSummary } from "../data/interactions";
import { touch, useTheme } from "../theme";
import { Txt } from "../ui/kit";
import { OrderButton, Panel } from "./controls";
import { AgentChat, InitiativeDetail, Orders } from "./Detail";
import { StateLabel, StateMark } from "./graphics";
import { answerRequest, type Project, queue, updateAgent, waited } from "./model";
import { Overview } from "./Overview";
import { Request } from "./Request";
import { AgentSheet, Sheet } from "./Sheets";
import { sampleProject, simulate, stressProject } from "./sample";

export function Command({
  onClose,
  initialProject,
}: {
  onClose?: () => void;
  initialProject?: Project;
} = {}) {
  const { c } = useTheme();
  const largeType = useWindowDimensions().fontScale > 1.4;
  const insets = useSafeAreaInsets();
  const [project, setProject] = useState<Project>(() => initialProject ?? sampleProject());
  const latestProject = useRef(project);
  latestProject.current = project;
  const [focusId, setFocus] = useState<string>();
  const [detailId, setDetail] = useState<string>();
  const [sheetId, setSheet] = useState<string>();
  const [chatId, setChat] = useState<string>();
  const [requestId, setRequest] = useState<string>();
  const [unblocking, setUnblocking] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [options, setOptions] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [order, setOrder] = useState("Report progress and the next risk.");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(true);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const tick = useRef(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
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
  const sheetInitiative = project.initiatives.find((i) => i.agents.some((a) => a.id === sheetId));
  const chat = all.find((a) => a.id === chatId);
  const pending = queue(project);
  const current = pending.find((e) => e.request.id === requestId);
  const oldest = pending[0];
  const overview = !unblocking && !chat && !detail && !ordering;
  const home = () => {
    setNotice("");
    setUnblocking(false);
    setRequest(undefined);
    setChat(undefined);
    setDetail(undefined);
    setOrdering(false);
    setSelected([]);
    setSheet(undefined);
  };
  const openRequest = (id?: string) => {
    if (!id) return;
    setNotice("");
    setSheet(undefined);
    setUnblocking(true);
    setOrdering(false);
    setRequest(id);
  };
  const openDetail = (id: string) => {
    setNotice("");
    setFocus(id);
    setDetail(id);
    setSelected([]);
    setSheet(undefined);
  };
  const applyOrder = (ids: string[], stop = false, text = order) => {
    if (!stop && !text.trim()) return;
    setProject((p) =>
      ids.reduce(
        (next, id) =>
          updateAgent(next, id, (a) => ({
            ...a,
            ...(stop
              ? { state: "idle" as const, request: undefined, activity: "Stopped by you" }
              : {}),
            messages: [...a.messages, stop ? "Stopped by you." : text.trim()],
          })),
        p,
      ),
    );
    setNotice(stop ? `${ids.length} agents stopped` : `Sent to ${ids.length} agents`);
    setSelected([]);
    setOrdering(false);
  };
  const stop = (ids: string[]) =>
    Alert.alert(
      `Stop ${ids.length === 1 ? "this agent" : `${ids.length} agents`}?`,
      "They stop now. Pending sample requests are cancelled.",
      [
        { text: "Keep running", style: "cancel" },
        { text: "Stop", style: "destructive", onPress: () => applyOrder(ids, true) },
      ],
    );
  const reset = (size: "full" | "tiny" | "empty" | "forty") => {
    setProject(size === "forty" ? stressProject() : sampleProject(size));
    tick.current = 0;
    home();
    setFocus(undefined);
    setNotice("");
    setOptions(false);
  };
  const unblock = (
    <View style={[s.dock, { backgroundColor: c["bg-frame"], borderTopColor: c.border }]}>
      <View style={[s.signal, { borderColor: oldest ? c.attention : c["text-secondary"] }]}>
        <StateMark state={oldest ? "needs_you" : "review"} size={23} />
      </View>
      <View style={s.flex}>
        <Txt v="section">{oldest ? `${pending.length} agents need you` : "All clear"}</Txt>
        <Txt v="meta" tone="secondary">
          {oldest ? `Oldest · ${waited(oldest.request, now)}` : "No requests waiting"}
        </Txt>
      </View>
      <OrderButton
        label="Unblock →"
        attention
        disabled={!oldest}
        onPress={() => openRequest(oldest?.request.id)}
      />
    </View>
  );
  const title = unblocking
    ? "Needs you"
    : ordering
      ? "Orders"
      : chat
        ? "Sample chat"
        : (detail?.name ?? project.name.split(" · ").at(-1) ?? "Project command");
  const header = (
    <View style={[s.header, largeType && { paddingHorizontal: 0 }]}>
      {overview ? (
        <Txt v="meta" tone="secondary">
          Bracken Supply
        </Txt>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ordering ? "Back to initiative" : "Back to project"}
          onPress={() => (ordering ? setOrdering(false) : home())}
          style={s.back}
        >
          <Txt v="meta" tone="secondary">
            ← {ordering ? "Initiative" : "Project"}
          </Txt>
        </Pressable>
      )}
      <View style={s.titleRow}>
        <Txt v="largeTitle" accessibilityRole="header" style={s.flex}>
          {title}
        </Txt>
        {overview ? (
          <StateLabel state={running ? "working" : "idle"} label={running ? "Live" : "Paused"} />
        ) : null}
      </View>
      {overview ? (
        <View style={[s.stats, { borderColor: c.border }]}>
          {[
            [String(all.filter((a) => a.state === "working").length), "working", c.text],
            [String(pending.length), "need you", c.attention],
            [`$${project.spend.toFixed(2)}`, "today", c.text],
            [
              String(project.initiatives.reduce((n, i) => n + i.checks.length, 0)),
              "checks",
              c.danger,
            ],
          ].map(([value, label, color]) => (
            <View key={label} accessible accessibilityLabel={`${value} ${label}`} style={s.stat}>
              <Txt v="code" style={{ color }}>
                {value}
              </Txt>
              <Txt v="meta" style={{ color }}>
                {label}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
  const navigation = (
    <View style={[s.nav, { backgroundColor: c["bg-frame"], paddingBottom: insets.bottom }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Project overview"
        accessibilityState={{ selected: overview }}
        style={[s.navButton, overview && { borderTopWidth: 2, borderTopColor: c["accent-text"] }]}
        onPress={home}
      >
        <Txt v="meta" tone={overview ? "text" : "muted"}>
          Project
        </Txt>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Requests, ${pending.length} waiting`}
        accessibilityState={{ selected: unblocking, disabled: !oldest && !unblocking }}
        disabled={!oldest && !unblocking}
        style={s.navButton}
        onPress={() => !unblocking && openRequest(oldest?.request.id)}
      >
        <Txt v="meta" tone={pending.length ? "attention" : "muted"}>
          Requests {pending.length}
        </Txt>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Prototype options"
        style={s.navButton}
        onPress={() => setOptions(true)}
      >
        <Txt v="meta" tone="muted">
          Prototype
        </Txt>
      </Pressable>
    </View>
  );
  const selection =
    detail && selected.length && !ordering && !unblocking && !chat ? (
      <View
        style={[s.selection, { borderColor: c["accent-text"], backgroundColor: c["bg-raised"] }]}
      >
        <Txt v="section">{selected.length} selected</Txt>
        <OrderButton label="Orders →" onPress={() => setOrdering(true)} />
        <OrderButton label="Stop" onPress={() => stop(selected)} />
      </View>
    ) : null;
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[s.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}
    >
      {!largeType ? header : null}
      <ScrollView
        ref={scroll}
        key={
          unblocking
            ? (requestId ?? "clear")
            : ordering
              ? "orders"
              : (chatId ?? detailId ?? "overview")
        }
        contentContainerStyle={s.body}
        keyboardShouldPersistTaps="handled"
      >
        {largeType ? header : null}
        <View
          accessibilityLiveRegion="polite"
          style={notice ? { paddingHorizontal: 0 } : { position: "absolute", height: 0 }}
        >
          {notice ? (
            <Txt v="meta" tone="accent">
              {notice}
            </Txt>
          ) : null}
        </View>
        {unblocking ? (
          current ? (
            <Panel attention>
              <View style={s.requestIdentity}>
                <StateLabel state="needs_you" label={`Waiting ${waited(current.request, now)}`} />
                <Txt v="code" tone="secondary">
                  {pending.length} remaining
                </Txt>
              </View>
              <Txt v="meta" tone="secondary">
                {current.initiative.name} · Unit {current.agent.id.replace("unit-", "")}
              </Txt>
              <Request
                key={current.request.id}
                request={current.request}
                answer={(draft) => {
                  const next = answerRequest(
                    latestProject.current,
                    current.request.id,
                    draft.answers
                      ? current.request.items
                          .map((item) => answerSummary(item, draft.answers?.[item.id]))
                          .join("; ")
                      : [
                          draft.action === "accept" ? "Approved" : "Declined",
                          draft.choice === "allow_session"
                            ? "Commands allowed for this session"
                            : draft.choice === "allow_accept_edits"
                              ? "Edits allowed for this session"
                              : "",
                          draft.feedback,
                        ]
                          .filter(Boolean)
                          .join(". "),
                  );
                  setProject(next);
                  setRequest(queue(next)[0]?.request.id);
                  setNotice("Answer recorded");
                }}
              />
            </Panel>
          ) : (
            <Panel>
              <StateMark state="review" size={30} />
              <Txt v="cardTitle">All requests answered</Txt>
              <Txt tone="secondary">Your agents can carry on.</Txt>
              <OrderButton label="Back to project" onPress={home} />
            </Panel>
          )
        ) : ordering ? (
          <Orders
            selected={selected}
            agents={all}
            order={order}
            setOrder={setOrder}
            send={() => applyOrder(selected)}
            stop={() => stop(selected)}
          />
        ) : chat ? (
          <AgentChat
            agent={chat}
            message={message}
            setMessage={setMessage}
            send={() => {
              applyOrder([chat.id], false, message);
              setMessage("");
            }}
          />
        ) : detail ? (
          <InitiativeDetail
            initiative={detail}
            selected={selected}
            now={now}
            toggle={(id) =>
              setSelected((ids) =>
                ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id],
              )
            }
            openAgent={setSheet}
          />
        ) : (
          <Overview
            project={project}
            focusId={focusId}
            now={now}
            onFocus={(id) => {
              setFocus(id);
              scroll.current?.scrollTo({ y: 0, animated: false });
            }}
            onDetail={openDetail}
            onAgent={setSheet}
            onRequest={openRequest}
          />
        )}
        {largeType ? (
          <>
            {selection}
            {!unblocking ? unblock : null}
            {navigation}
          </>
        ) : null}
      </ScrollView>
      {!largeType ? (
        <>
          {selection}
          {!unblocking ? unblock : null}
          {navigation}
        </>
      ) : (
        <View
          style={{
            paddingHorizontal: 14,
            paddingTop: 8,
            paddingBottom: insets.bottom + 8,
            backgroundColor: c["bg-frame"],
          }}
        >
          <OrderButton
            label={unblocking ? "Project" : oldest ? "Unblock" : "All clear"}
            attention={!unblocking && !!oldest}
            onPress={() => (unblocking ? home() : openRequest(oldest?.request.id))}
            disabled={!unblocking && !oldest}
          />
        </View>
      )}
      <AgentSheet
        agent={sheet}
        initiativeName={sheetInitiative?.name}
        now={now}
        close={() => setSheet(undefined)}
        answer={() => openRequest(sheet?.request?.id)}
        message={() => {
          setChat(sheet?.id);
          setSheet(undefined);
        }}
        stop={() => sheet && stop([sheet.id])}
        unblock={unblock}
        openInitiative={() => sheetInitiative && openDetail(sheetInitiative.id)}
      />
      <Sheet visible={options} close={() => setOptions(false)} title="Prototype">
        <Txt tone="secondary">Fictional sample data. Orders and answers stay on this phone.</Txt>
        <OrderButton
          label={running ? "Pause live sample" : "Resume live sample"}
          onPress={() => setRunning(!running)}
        />
        <OrderButton label="Full sample" onPress={() => reset("full")} />
        <OrderButton label="40-agent sample" onPress={() => reset("forty")} />
        <OrderButton label="Tiny sample" onPress={() => reset("tiny")} />
        <OrderButton label="Empty sample" onPress={() => reset("empty")} />
        {onClose ? <OrderButton label="Close prototype" onPress={onClose} /> : null}
      </Sheet>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 14, paddingTop: 6, paddingBottom: 8, gap: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  flex: { flex: 1, minWidth: 0 },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  stat: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 4 },
  body: { paddingHorizontal: 14, paddingBottom: 8, gap: 10 },
  back: { minHeight: touch, alignSelf: "flex-start", justifyContent: "center", paddingEnd: 16 },
  dock: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    borderTopWidth: 1,
  },
  signal: {
    minWidth: 36,
    minHeight: 36,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  nav: { flexDirection: "row", justifyContent: "space-around", flexWrap: "wrap", gap: 4 },
  navButton: {
    minHeight: touch,
    minWidth: touch,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  selection: {
    padding: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderTopWidth: 1,
  },
  requestIdentity: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 6,
  },
});
