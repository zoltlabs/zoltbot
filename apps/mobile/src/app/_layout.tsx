import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { View } from "react-native";
import { useLink } from "../state/link";
import { startNotificationActions } from "../state/notifications";
import { useTheme } from "../theme";
import { SharingLifecycle } from "../ui/SharingLifecycle";

export default function RootLayout() {
  const { scheme, c } = useTheme();
  const booted = useLink((state) => state.booted);
  useEffect(() => {
    void useLink.getState().boot();
  }, []);
  // Notification taps and Allow/Reject buttons, once screens can be navigated to.
  useEffect(() => (booted ? startNotificationActions() : undefined), [booted]);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(c["bg-page"]);
  }, [c]);
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      background: c["bg-page"],
      card: c["bg-page"],
      text: c.text,
      border: c.border,
      primary: c["accent-text"],
    },
  };
  if (!booted) return <View style={{ flex: 1, backgroundColor: c["bg-page"] }} />;
  return (
    <ThemeProvider value={theme}>
      <SharingLifecycle />
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          statusBarStyle: scheme === "dark" ? "light" : "dark",
          contentStyle: { backgroundColor: c["bg-page"] },
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="pair" options={{ gestureEnabled: false }} />
        <Stack.Screen
          name="project-sheet"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="new" options={{ presentation: "modal" }} />
        <Stack.Screen
          name="chat/fork"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="chat/edit"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="zolt-settings"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="chat/send"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="knowledge-edit"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="profile/[id]"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}
