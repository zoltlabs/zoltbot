import { Pressable, StyleSheet, View } from "react-native";
import { touch, useTheme } from "../theme";
import { Field } from "../ui/interactions/parts";
import { Txt } from "../ui/kit";
import { OrderButton, Panel, Progress } from "./controls";
import { StateLabel, UnitPortrait } from "./graphics";
import { type Agent, type Initiative, marks, waited } from "./model";

export function AgentIdentity({ agent }: { agent: Agent }) {
  return (
    <View style={s.identity}>
      <UnitPortrait agent={agent} size={30} />
      <View style={s.flex}>
        <Txt v="section">{agent.title.split(" · ")[0]}</Txt>
        <Txt v="meta" tone="secondary">
          {agent.provider} · Unit {agent.id.replace("unit-", "")}
        </Txt>
        <StateLabel state={agent.state} />
      </View>
    </View>
  );
}
export function InitiativeDetail({
  initiative,
  selected,
  now,
  toggle,
  openAgent,
}: {
  initiative: Initiative;
  selected: string[];
  now: number;
  toggle: (id: string) => void;
  openAgent: (id: string) => void;
}) {
  const { c } = useTheme();
  return (
    <View style={s.body}>
      <Txt tone="secondary">{initiative.goal}</Txt>
      <Progress initiative={initiative} />
      <View style={s.heading}>
        <Txt v="section" accessibilityRole="header">
          Agents
        </Txt>
        <Txt v="meta" tone="secondary">
          {selected.length ? `${selected.length} selected` : `${initiative.agents.length} units`}
        </Txt>
      </View>
      {initiative.agents.map((agent) => (
        <View
          key={agent.id}
          style={[
            s.agent,
            {
              backgroundColor: c["bg-raised"],
              borderColor: selected.includes(agent.id) ? c["accent-text"] : c.border,
            },
          ]}
        >
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Select ${agent.title}`}
            accessibilityState={{ checked: selected.includes(agent.id) }}
            onPress={() => toggle(agent.id)}
            style={s.check}
          >
            <View
              style={[
                s.checkBox,
                {
                  borderColor: c["border-control"],
                  backgroundColor: selected.includes(agent.id) ? c["accent-soft"] : c["bg-frame"],
                },
              ]}
            >
              <Txt v="meta">{selected.includes(agent.id) ? "✓" : ""}</Txt>
            </View>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${agent.title}, ${marks[agent.state].label}. ${agent.activity}. Open agent details.`}
            onPress={() => openAgent(agent.id)}
            style={s.agentContent}
          >
            <AgentIdentity agent={agent} />
            <Txt v="meta" tone="secondary">
              {agent.activity}
            </Txt>
            {agent.request ? (
              <Txt v="code" tone="attention">
                Waiting {waited(agent.request, now)}
              </Txt>
            ) : null}
          </Pressable>
          <Txt tone="muted" style={{ paddingTop: 12 }}>
            ›
          </Txt>
        </View>
      ))}
      <Panel>
        <Txt v="section" accessibilityRole="header">
          Last 24 hours
        </Txt>
        <Txt>{initiative.changes}</Txt>
        <Txt v="section" accessibilityRole="header">
          Open pull requests
        </Txt>
        {initiative.prs.length ? (
          initiative.prs.map((pr) => (
            <Txt v="code" key={pr}>
              {pr}
            </Txt>
          ))
        ) : (
          <Txt tone="secondary">No open pull requests</Txt>
        )}
        <Txt v="section" accessibilityRole="header">
          Required checks
        </Txt>
        {initiative.checks.length ? (
          initiative.checks.map((check) => <StateLabel key={check} state="problem" label={check} />)
        ) : (
          <Txt tone="secondary">No failing required checks</Txt>
        )}
      </Panel>
    </View>
  );
}
export function Orders({
  selected,
  agents,
  order,
  setOrder,
  send,
  stop,
}: {
  selected: string[];
  agents: Agent[];
  order: string;
  setOrder: (value: string) => void;
  send: () => void;
  stop: () => void;
}) {
  return (
    <Panel>
      <Txt v="cardTitle" accessibilityRole="header">
        {selected.length} agents selected
      </Txt>
      <Txt v="meta" tone="secondary">
        {agents
          .filter((a) => selected.includes(a.id))
          .map((a) => `Unit ${a.id.replace("unit-", "")} · ${a.title.split(" · ")[0]}`)
          .join("\n")}
      </Txt>
      <View style={s.presets}>
        <OrderButton
          label="Report progress"
          onPress={() => setOrder("Report progress and the next risk.")}
        />
        <OrderButton
          label="Focus on checks"
          onPress={() => setOrder("Fix failing required checks before new work.")}
        />
      </View>
      <Field label="Order" value={order} onChange={setOrder} multiline />
      <OrderButton
        label="Send order"
        attention
        disabled={!selected.length || !order.trim()}
        onPress={send}
      />
      <OrderButton label="Stop selected agents" disabled={!selected.length} onPress={stop} />
    </Panel>
  );
}
export function AgentChat({
  agent,
  message,
  setMessage,
  send,
}: {
  agent: Agent;
  message: string;
  setMessage: (value: string) => void;
  send: () => void;
}) {
  return (
    <View style={s.body}>
      <AgentIdentity agent={agent} />
      <Panel>
        <Txt v="section">Last result</Txt>
        <Txt>{agent.result}</Txt>
      </Panel>
      {agent.messages.map((text, index) => (
        <Panel
          // biome-ignore lint/suspicious/noArrayIndexKey: sample messages are append-only
          key={`${index}-${text}`}
        >
          <Txt>{text}</Txt>
        </Panel>
      ))}
      <Field label="Message" value={message} onChange={setMessage} multiline />
      <OrderButton label="Send message" disabled={!message.trim()} attention onPress={send} />
    </View>
  );
}
const s = StyleSheet.create({
  body: { gap: 10 },
  flex: { flex: 1, minWidth: 0 },
  identity: { flexDirection: "row", alignItems: "center", gap: 12 },
  heading: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 8,
  },
  agent: { flexDirection: "row", alignItems: "flex-start", borderWidth: 1, paddingEnd: 10 },
  agentContent: { flex: 1, minWidth: 0, paddingVertical: 10, gap: 6, minHeight: touch },
  check: {
    minWidth: touch,
    minHeight: touch,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 12,
  },
  checkBox: {
    minWidth: 20,
    minHeight: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
});
