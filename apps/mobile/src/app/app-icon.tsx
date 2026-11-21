// P7: Settings › App icon. iOS confirms the change with its own notice.
import { useEffect, useRef } from "react";
import { Alert, Image, ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { appIcons } from "../data/app-icons";
import { useAppIcon } from "../state/app-icon";
import { useTheme } from "../theme";
import { BackBar } from "../ui/chrome";
import { Icon } from "../ui/icons";
import { Group, Row, Txt } from "../ui/kit";

const previews = {
  classic: require("../../assets/icons/classic-preview.png"),
  paper: require("../../assets/icons/paper-preview.png"),
  amber: require("../../assets/icons/amber-preview.png"),
  mono: require("../../assets/icons/mono-preview.png"),
};

export default function AppIcon() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { current, choose } = useAppIcon();
  // iOS changes one icon at a time; a second tap while it works is ignored.
  const changing = useRef(false);
  useEffect(() => {
    void useAppIcon.getState().refresh();
  }, []);
  return (
    <ScrollView
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={[
        styles.page,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 16 },
      ]}
    >
      <BackBar label="Settings" />
      <Txt v="largeTitle" accessibilityRole="header">
        App icon
      </Txt>
      <Group>
        {appIcons.map((icon, index) => (
          <Row
            key={icon.id}
            title={icon.name}
            selected={icon.id === current.id}
            right={
              icon.id === current.id ? (
                <Icon name="check" size={18} color={c["accent-text"]} />
              ) : null
            }
            left={
              <Image
                source={previews[icon.id]}
                style={[styles.preview, { borderColor: c.border }]}
                accessibilityIgnoresInvertColors
              />
            }
            disabled={icon.id === current.id}
            onPress={() => {
              if (changing.current) return;
              changing.current = true;
              void choose(icon).then((result) => {
                changing.current = false;
                if (result !== "ok") Alert.alert("The icon wasn't changed", result.reason);
              });
            }}
            last={index === appIcons.length - 1}
          />
        ))}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, gap: 16 },
  preview: { width: 40, height: 40, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth },
});
