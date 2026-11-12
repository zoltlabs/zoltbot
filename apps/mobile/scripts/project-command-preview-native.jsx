// Browser-only native host adapter for prototype screenshots. It approximates Yoga layout;
// it cannot establish iOS text wrapping, safe-area geometry or VoiceOver correctness.
import React, { forwardRef, useImperativeHandle, useRef } from "react";

const scale = () => Number(new URLSearchParams(location.search).get("scale")) || 1;
const flatten = (value) =>
  Array.isArray(value)
    ? Object.assign({}, ...value.map(flatten))
    : value && typeof value === "object"
      ? value
      : {};
function css(input) {
  const result = flatten(typeof input === "function" ? input({ pressed: false }) : input);
  for (const [key, a, b] of [
    ["paddingHorizontal", "paddingLeft", "paddingRight"],
    ["paddingVertical", "paddingTop", "paddingBottom"],
    ["marginHorizontal", "marginLeft", "marginRight"],
    ["marginVertical", "marginTop", "marginBottom"],
  ])
    if (key in result) {
      result[a] = result[key];
      result[b] = result[key];
      delete result[key];
    }
  for (const [key, target] of [
    ["paddingEnd", "paddingInlineEnd"],
    ["paddingStart", "paddingInlineStart"],
  ])
    if (key in result) {
      result[target] = result[key];
      delete result[key];
    }
  if (typeof result.lineHeight === "number") result.lineHeight = `${result.lineHeight * scale()}px`;
  if (typeof result.fontSize === "number") result.fontSize *= scale();
  if (Array.isArray(result.transform))
    result.transform = result.transform
      .map((entry) =>
        Object.entries(entry)
          .map(([key, value]) => `${key}(${typeof value === "number" ? `${value}px` : value})`)
          .join(" "),
      )
      .join(" ");
  return result;
}
const base = {
  display: "flex",
  flexDirection: "column",
  position: "relative",
  flexShrink: 0,
  boxSizing: "border-box",
  minWidth: 0,
  minHeight: 0,
  borderWidth: 0,
  borderStyle: "solid",
  alignItems: "stretch",
};
const attributes = (props) => ({
  "aria-label": props.accessibilityLabel,
  "aria-disabled": props.disabled || undefined,
  "aria-checked": props.accessibilityState?.checked,
  "aria-expanded": props.accessibilityState?.expanded,
});
export const View = ({ children, style, ...props }) => (
  <div {...attributes(props)} style={{ ...base, ...css(style) }}>
    {children}
  </div>
);
export const Text = ({ children, style, ...props }) => (
  <span
    {...attributes(props)}
    style={{
      fontFamily: "Geist",
      fontSize: 15 * scale(),
      lineHeight: `${21 * scale()}px`,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
      flexShrink: 1,
      minWidth: 0,
      ...css(style),
    }}
  >
    {children}
  </span>
);
export const Pressable = ({ children, style, onPress, disabled, accessibilityRole, ...props }) => (
  <button
    {...attributes(props)}
    role={accessibilityRole}
    disabled={disabled}
    onClick={onPress}
    style={{
      ...base,
      appearance: "none",
      background: "transparent",
      color: "inherit",
      padding: 0,
      textAlign: "start",
      cursor: "pointer",
      font: "inherit",
      ...css(style),
    }}
  >
    {children}
  </button>
);
export const ScrollView = forwardRef(({ children, style, contentContainerStyle }, ref) => {
  const node = useRef();
  useImperativeHandle(ref, () => ({
    scrollTo: ({ y }) => {
      node.current.scrollTop = y;
    },
  }));
  return (
    <div
      ref={node}
      data-scroll
      style={{ ...base, flexGrow: 1, flexShrink: 1, overflow: "auto", ...css(style) }}
    >
      <div style={{ ...base, ...css(contentContainerStyle) }}>{children}</div>
    </div>
  );
});
export const TextInput = ({
  style,
  value,
  onChangeText,
  multiline,
  accessibilityLabel,
  placeholder,
  editable,
}) =>
  React.createElement(multiline ? "textarea" : "input", {
    "aria-label": accessibilityLabel,
    placeholder,
    disabled: editable === false,
    value,
    onChange: (event) => onChangeText?.(event.target.value),
    style: { ...css(style), boxSizing: "border-box", fontFamily: "Geist", resize: "vertical" },
  });
export const Modal = ({ visible, children }) =>
  visible ? (
    <div
      role="dialog"
      aria-modal="true"
      style={{ ...base, position: "fixed", inset: 0, zIndex: 100 }}
    >
      {children}
    </div>
  ) : null;
export const StyleSheet = { create: (value) => value, hairlineWidth: 1 };
export const useWindowDimensions = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
  fontScale: scale(),
});
export const Alert = {
  alert: (title, message, buttons) => {
    if (window.confirm(`${title}\n${message}`)) buttons.at(-1)?.onPress?.();
  },
};
export const useColorScheme = () =>
  new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";

export const KeyboardAvoidingView = View;
