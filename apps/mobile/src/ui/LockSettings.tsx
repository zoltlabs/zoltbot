import { Alert } from "react-native";
import { lockAfterLabels, lockAfterOptions } from "../data/app-lock";
import { useAppLock } from "../state/app-lock";
import { Group, Row, showMenu } from "./kit";
import { Toggle } from "./Toggle";

/** Settings: Lock with Face ID, and how long the app may sit in the background first. */
export function LockSettings() {
  const { prefs, setPrefs } = useAppLock();
  const turn = async (enabled: boolean) => {
    const result = await setPrefs({ enabled });
    if (result === "failed") Alert.alert("The lock wasn't changed", "Try again.");
    if (result === "unavailable")
      Alert.alert("Set a passcode first", "Turn on a screen lock in your phone's settings.");
  };
  return (
    <Group>
      <Toggle
        label="Lock with Face ID"
        value={prefs.enabled}
        onChange={(value) => void turn(value)}
        last={!prefs.enabled}
      />
      {prefs.enabled ? (
        <Row
          title="Lock after"
          detail={lockAfterLabels[prefs.after]}
          onPress={() =>
            showMenu(
              lockAfterOptions.map((after) => ({
                label: lockAfterLabels[after],
                onPress: () =>
                  void setPrefs({ after }).then((result) => {
                    if (result === "failed") Alert.alert("The lock wasn't changed", "Try again.");
                  }),
              })),
              "Lock after",
            )
          }
          last
        />
      ) : null}
    </Group>
  );
}
