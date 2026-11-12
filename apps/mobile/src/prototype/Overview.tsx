import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { touch, useTheme } from "../theme";
import { Txt } from "../ui/kit";
import { Health, Progress } from "./controls";
import { Emblem, StateLegend, StateMark, UnitPortrait } from "./graphics";
import {
  focusedInitiative,
  marks,
  type Project,
  queue,
  sorted,
  unitWidth,
  waited,
  waiting,
} from "./model";

export function Overview({
  project,
  focusId,
  now,
  onFocus,
  onDetail,
  onAgent,
  onRequest,
}: {
  project: Project;
  focusId?: string;
  now: number;
  onFocus: (id: string) => void;
  onDetail: (id: string) => void;
  onAgent: (id: string) => void;
  onRequest: (id: string) => void;
}) {
  const { c } = useTheme();
  const { fontScale } = useWindowDimensions();
  const focused = focusedInitiative(project, focusId);
  if (!focused)
    return (
      <View style={s.empty}>
        <Txt v="cardTitle">No initiatives yet</Txt>
        <Txt tone="secondary">Open Prototype to choose a sample project.</Txt>
      </View>
    );
  const request = queue(project).find((e) => e.initiative.id === focused.id);
  const count = waiting(focused);
  return (
    <View style={s.overview}>
      <View
        style={[
          s.focused,
          {
            backgroundColor: c["bg-raised"],
            borderColor: count ? c.attention : c["border-control"],
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${focused.name} details. ${focused.goal}`}
          onPress={() => onDetail(focused.id)}
          style={s.focusHead}
        >
          <Txt v="cardTitle" style={s.flex}>
            {focused.name}
          </Txt>
          <Health initiative={focused} />
          <Txt tone="muted">↗</Txt>
        </Pressable>
        <Txt v="meta" tone="secondary">
          {focused.goal}
        </Txt>
        <View style={s.progressLine}>
          <Txt v="code">
            {focused.done}/{focused.total} tasks
          </Txt>
          <Txt v="meta" tone={count ? "attention" : "secondary"}>
            {count === focused.agents.length
              ? "All agents waiting"
              : `${focused.agents.length} agents`}
          </Txt>
        </View>
        <Progress initiative={focused} compact />
        <View style={s.units}>
          {focused.agents.map((agent) => (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              accessibilityLabel={`Agent ${agent.id.replace("unit-", "")}, ${agent.provider}, ${marks[agent.state].label}. ${agent.activity}. Open agent details.`}
              onPress={() => onAgent(agent.id)}
              style={({ pressed }) => [
                s.pod,
                {
                  minWidth: unitWidth(fontScale),
                  borderBottomColor: c[`provider-${agent.provider}`],
                  backgroundColor: c[pressed ? "bg-active" : "bg-frame"],
                },
              ]}
            >
              <StateMark state={agent.state} size={12} />
              <UnitPortrait agent={agent} size={23} />
              <Txt v="code">{agent.id.replace("unit-", "")}</Txt>
            </Pressable>
          ))}
        </View>
        {request ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${request.request.title}. Waiting ${waited(request.request, now)}. Answer request.`}
            onPress={() => onRequest(request.request.id)}
            style={[s.request, { borderTopColor: c.border }]}
          >
            <StateMark state="needs_you" size={14} />
            <View style={s.flex}>
              <Txt v="meta" tone="attention">
                {request.request.title}
              </Txt>
              <Txt v="meta" tone="secondary">
                Waiting {waited(request.request, now)}
              </Txt>
            </View>
            <Txt tone="attention">→</Txt>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${focused.name} details and orders`}
            onPress={() => onDetail(focused.id)}
            style={[s.request, { borderTopColor: c.border }]}
          >
            <Txt v="meta" tone="accent">
              Activity and orders
            </Txt>
            <Txt tone="accent">→</Txt>
          </Pressable>
        )}
      </View>
      {sorted(project)
        .filter((i) => i.id !== focused.id)
        .map((initiative) => (
          <Pressable
            key={initiative.id}
            accessibilityRole="button"
            accessibilityState={{ expanded: false }}
            accessibilityLabel={`${initiative.name}. ${initiative.goal} ${initiative.agents.length} agents, ${initiative.done} of ${initiative.total} tasks, ${waiting(initiative)} need you. ${initiative.agents.map((a) => `${a.provider} ${a.id}: ${marks[a.state].label}`).join(". ")}. Focus squad.`}
            onPress={() => onFocus(initiative.id)}
            style={({ pressed }) => [
              s.collapsed,
              { backgroundColor: c[pressed ? "bg-active" : "bg-raised"], borderColor: c.border },
            ]}
          >
            <Emblem id={initiative.id} />
            <View style={s.flex}>
              <View style={s.nameLine}>
                <Txt v="section" style={s.flex}>
                  {initiative.name}
                </Txt>
                <Health initiative={initiative} />
              </View>
              <View style={s.metaLine}>
                <Txt v="meta" tone="muted">
                  {initiative.agents.length} agents · {initiative.done}/{initiative.total} tasks
                </Txt>
                <View style={s.miniUnits}>
                  {initiative.agents.map((a) => (
                    <StateMark key={a.id} state={a.state} size={10} />
                  ))}
                </View>
              </View>
            </View>
            <Txt tone="muted">›</Txt>
          </Pressable>
        ))}
      <StateLegend />
    </View>
  );
}
const s = StyleSheet.create({
  overview: { gap: 6 },
  focused: { borderWidth: 1, paddingHorizontal: 10, paddingTop: 4, gap: 4 },
  focusHead: {
    minHeight: touch,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
  },
  flex: { flex: 1, minWidth: 0 },
  progressLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 4,
    marginTop: 4,
  },
  units: { flexDirection: "row", flexWrap: "wrap", gap: 4, paddingVertical: 6 },
  pod: { minHeight: touch, alignItems: "center", paddingVertical: 4, gap: 3, borderBottomWidth: 2 },
  request: {
    minHeight: touch,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderTopWidth: 1,
    paddingVertical: 4,
  },
  collapsed: {
    minHeight: touch,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  nameLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  metaLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  miniUnits: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  empty: { paddingVertical: 40, gap: 10 },
});
