import { Switch } from "react-native";
import { useTheme } from "../theme";
import { Row } from "./kit";

/** A settings row with a switch; tapping the row flips it too. */
export function Toggle({
  label,
  note,
  value,
  onChange,
  last,
  disabled,
}: {
  label: string;
  note?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Row
      title={label}
      {...(note ? { meta: note } : {})}
      last={last ?? false}
      onPress={() => onChange(!value)}
      checked={value}
      disabled={disabled}
      right={
        <Switch
          value={value}
          disabled={disabled}
          onValueChange={onChange}
          accessibilityLabel={label}
          trackColor={{ true: c.accent, false: c["bg-active"] }}
        />
      }
    />
  );
}
