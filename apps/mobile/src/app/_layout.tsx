import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { View } from "react-native";
import { startAppLock, useAppLock } from "../state/app-lock";
import { useLink } from "../state/link";
import { startLiveActivity } from "../state/live-activity";
import { startNotificationActions } from "../state/notifications";
import { startPushRegistration } from "../state/push-registration";
import { useTextSize } from "../state/text-size";
import { loadVoicePrefs } from "../state/voice-prefs";
import { useTheme } from "../theme";
import { BotAvatarPalette } from "../ui/BotAvatar";
import { LockScreen } from "../ui/LockScreen";
import { MenuSheet } from "../ui/MenuSheet";
import { PromptSheet } from "../ui/PromptSheet";
import { SharingLifecycle } from "../ui/SharingLifecycle";

export default function RootLayout() {
  const { scheme, c } = useTheme();
  const booted = useLink((state) => state.booted);
  const lockReady = useAppLock((state) => state.ready);
  useEffect(() => {
    startAppLock();
    void useLink.getState().boot();
    loadVoicePrefs();
    void useTextSize.getState().load();
  }, []);
  // Notification taps and Allow/Reject buttons, once screens can be navigated to.
  useEffect(() => (booted ? startNotificationActions() : undefined), [booted]);
  useEffect(() => {
    if (!booted) return;
    startLiveActivity();
    startPushRegistration();
  }, [booted]);
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
  if (!booted || !lockReady) return <View style={{ flex: 1, backgroundColor: c["bg-page"] }} />;
  return (
    <BotAvatarPalette>
      <ThemeProvider value={theme}>
        <SharingLifecycle />
        <LockScreen />
        <MenuSheet />
        <PromptSheet />
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
          <Stack.Screen name="connection-done" options={{ animation: "none" }} />
          <Stack.Screen
            name="project-sheet"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen name="new" options={{ presentation: "modal" }} />
          {/* iOS 26 goes back on a swipe from anywhere, which would take the swipe that replies to a
              message. In a chat, only a swipe from the left edge goes back. */}
          <Stack.Screen
            name="chat/[id]"
            options={{ gestureResponseDistance: { start: 0, end: 30 } }}
          />
          <Stack.Screen
            name="chat/voice"
            options={{ presentation: "fullScreenModal", gestureEnabled: false }}
          />
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
            name="channel/info"
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
    </BotAvatarPalette>
  );
}
