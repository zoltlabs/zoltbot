import { Alert, Platform } from "react-native";
import { lockAfterLabels, lockAfterOptions } from "../data/app-lock";
import { useAppLock } from "../state/app-lock";
import { Group, Row, showMenu } from "./kit";
import { Toggle } from "./Toggle";

// Android phones unlock with a fingerprint, a face or the screen lock, so they get the general name.
const android = Platform.OS === "android";

/** Settings: Lock with Face ID, and how long the app may sit in the background first. */
export function LockSettings() {
  const { prefs, setPrefs } = useAppLock();
  const turn = async (enabled: boolean) => {
    const result = await setPrefs({ enabled });
    if (result === "unavailable" && enabled)
      Alert.alert(
        android ? "Set a screen lock first" : "Set a passcode first",
        "Turn on a screen lock in your phone's settings.",
      );
    else if (result === "failed" || result === "unavailable")
      Alert.alert("The lock wasn't changed", "Try again.");
  };
  return (
    <Group>
      <Toggle
        label={android ? "Lock with screen lock" : "Lock with Face ID"}
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
