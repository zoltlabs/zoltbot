import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useTheme } from "../theme";
import { Txt } from "../ui/kit";
import { type Agent, marks, type State, statePaths } from "./model";

/** Static vector marks survive font fallback and Reduce Motion. The caller supplies words. */
export function StateMark({ state, size = 16 }: { state: State; size?: number }) {
  const { c } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" accessible={false}>
      <Path d={statePaths[state]} fill="none" stroke={c[marks[state].tone]} strokeWidth={1.3} />
    </Svg>
  );
}
export function StateLabel({ state, label }: { state: State; label?: string }) {
  const { c } = useTheme();
  return (
    <View style={styles.label}>
      <StateMark state={state} size={13} />
      <Txt v="meta" style={{ color: c[marks[state].tone] }}>
        {label ?? marks[state].label}
      </Txt>
    </View>
  );
}
const equipment = {
  codex: "M12 1v5",
  claude: "M8 1v5M16 1v5",
  gemini: "M12 1l3 5h-6Z",
  cursor: "M7 2h10v3H7Z",
};
export function UnitPortrait({ agent, size = 30 }: { agent: Agent; size?: number }) {
  const { c } = useTheme();
  const provider = c[`provider-${agent.provider}`];
  return (
    <Svg width={size} height={size * 1.25} viewBox="0 0 24 30" accessible={false}>
      <Path
        d={equipment[agent.provider]}
        fill="none"
        stroke={c["text-secondary"]}
        strokeWidth={1.2}
      />
      <Path
        d="M6 6h12l3 5-2 10H5L3 11ZM6 23h4v5H5ZM14 23h4l1 5h-5Z"
        fill={c["bg-popover"]}
        stroke={c["text-secondary"]}
        strokeWidth={1.2}
      />
      <Path d="M7 10h10v6H7Z" fill={c["character-screen"]} stroke={provider} strokeWidth={1.5} />
      <Path
        d="M8 12h3M13 12h3M8 19h8M1 12v7M23 12v7"
        fill="none"
        stroke={provider}
        strokeWidth={1.5}
      />
    </Svg>
  );
}
const emblems = [
  "M2 6h15l4 6-4 6H2l4-6zM10 9l3 3-3 3",
  "M12 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 7v8M8 11h8M18 18l4 4",
  "M4 3h16v18H4zM4 9h16M9 9v12M7 6h1M11 6h1",
  "M3 3h14v17H3zM7 7h6M7 11h6M7 15h3M17 7h4v16H7v-3",
  "M3 4h18v16H3zM7 8l3 3-3 3M13 15h4",
  "M12 2v3M5 5l2 2M19 5l-2 2M4 15h16l-3-4V9a5 5 0 0 0-10 0v2zM9 19h6",
];
export function Emblem({ id }: { id: string }) {
  const { c } = useTheme();
  const index = Number(id.split("-").at(-1));
  return (
    <Svg width={25} height={25} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={emblems[index] ?? emblems[0]}
        stroke={c["text-secondary"]}
        fill="none"
        strokeWidth={1.4}
      />
    </Svg>
  );
}
export function StateLegend() {
  return (
    <View style={styles.legend} accessibilityLabel="State key">
      <StateLabel state="working" />
      <StateLabel state="needs_you" />
      <StateLabel state="review" label="Done" />
      <StateLabel state="idle" label="Idle / later" />
      <StateLabel state="problem" />
    </View>
  );
}
const styles = StyleSheet.create({
  label: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, flexWrap: "wrap" },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    justifyContent: "space-between",
    paddingVertical: 8,
  },
});
