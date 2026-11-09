import { router } from "expo-router";
import type { BottomTabBarProps } from "expo-router/js-tabs";
import { Pressable, StyleSheet, View } from "react-native";
import { needsYou } from "../data/view";
import { useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { Icon, type IconName } from "./icons";
import { Txt } from "./kit";

const tabs: Record<string, { label: string; icon: IconName }> = {
  index: { label: "Overview", icon: "overview" },
  tasks: { label: "Tasks", icon: "tasks" },
  compose: { label: "New chat", icon: "plus" },
  chats: { label: "Chats", icon: "chats" },
  settings: { label: "Settings", icon: "settings" },
};

/** The mockup's bar: five tabs, New chat as an accent pill that opens the composer sheet. */
export function TabBar({ state, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const count = needsYou(snapshot).length;
  return (
    <View
      accessibilityRole="tabbar"
      style={[
        styles.bar,
        {
          borderTopColor: c.border,
          backgroundColor: c["bg-page"],
          paddingBottom: insets.bottom || 8,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const tab = tabs[route.name];
        if (!tab) return null;
        const focused = index === state.index;
        const primary = route.name === "compose";
        const badge = route.name === "index" && count > 0 ? String(count) : "";
        const color = focused ? c["accent-text"] : c["text-muted"];
        const press = () => {
          if (primary) {
            router.push("/new");
            return;
          }
          const event = emitter.emit({
            type: "tabPress",
            target: route.key,
            canPreventDefault: true,
          });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        };
        return (
          <Pressable
            key={route.key}
            onPress={press}
            accessibilityRole={primary ? "button" : "tab"}
            accessibilityState={{ selected: focused }}
            accessibilityLabel={badge ? `${tab.label}, ${badge} need you` : tab.label}
            style={styles.tab}
          >
            <View style={[styles.pill, primary && { backgroundColor: c.primary }]}>
              <Icon name={tab.icon} color={primary ? c["text-on-primary"] : color} />
            </View>
            <Txt v="tab" style={{ color }}>
              {tab.label}
            </Txt>
            {badge ? (
              <View style={[styles.badge, { backgroundColor: c.attention }]}>
                <Txt v="tab" style={{ color: c["bg-page"] }}>
                  {badge}
                </Txt>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    paddingHorizontal: 4,
  },
  tab: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 3 },
  pill: { width: 48, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  badge: {
    position: "absolute",
    top: 0,
    left: "50%",
    marginLeft: 6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
