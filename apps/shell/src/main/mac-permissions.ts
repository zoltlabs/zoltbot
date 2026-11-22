import { desktopCapturer, shell, systemPreferences } from "electron";
import type { MacPermissionId, MacPermissionsState } from "../shared/ipc";

export function readComputerUsePrerequisites(): {
  screenRecording: boolean;
  accessibility: boolean;
} {
  if (process.platform !== "darwin") {
    return { screenRecording: false, accessibility: false };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen") === "granted",
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

export function readMacPermissions(): MacPermissionsState {
  if (process.platform !== "darwin") {
    return { screenRecording: "unknown", accessibility: "unknown" };
  }
  return {
    screenRecording: systemPreferences.getMediaAccessStatus("screen"),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
      ? "granted"
      : "not-determined",
  };
}

export async function requestMacPermission(
  permission: MacPermissionId,
): Promise<MacPermissionsState> {
  if (process.platform !== "darwin") return readMacPermissions();
  if (permission === "accessibility") {
    systemPreferences.isTrustedAccessibilityClient(true);
    return readMacPermissions();
  }

  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return readMacPermissions();
  // macOS reports "denied" for an app that has never asked, and lists an app under Screen
  // Recording only after it asks. Ask first so Zoltbot appears there, then open the pane.
  await desktopCapturer
    .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
    .catch(() => undefined);
  if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  return readMacPermissions();
}
