import { router } from "expo-router";
import { useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cloudSession, useCloud } from "../state/cloud";
import { usePush } from "../state/push";
import { useTheme } from "../theme";
import { BackBar } from "../ui/chrome";
import { Button, Group, Row, Section, Txt } from "../ui/kit";

export default function CloudAccount() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { checked, account, cell, error: accountError } = useCloud((state) => state);
  const pushLabel = usePush((state) => state.label);
  const pushBusy = usePush((state) => state.busy);
  const [busy, setBusy] = useState<"in" | "out" | null>(null);
  const [error, setError] = useState("");
  const flight = useRef(false);

  const run = async (action: "in" | "out") => {
    if (flight.current) return;
    flight.current = true;
    setBusy(action);
    setError("");
    try {
      if (action === "in") {
        await cloudSession.signIn();
        router.replace("/cloud-needs-you");
      } else if (account.sessionId) {
        await cloudSession.signOut(account.sessionId);
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code !== "sign_in_cancelled")
        setError(
          action === "out" && code === "sign_out_unconfirmed"
            ? "Signed out on this phone. Check your account sessions to revoke access."
            : action === "out"
              ? "Couldn’t sign out. Try again."
              : "Couldn’t sign in. Try again.",
        );
    } finally {
      flight.current = false;
      setBusy(null);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <BackBar label="Zoltbot" />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 16 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Txt v="largeTitle" accessibilityRole="header">
          Zoltbot Cloud
        </Txt>
        <View accessibilityLiveRegion="polite">
          {error ? <Txt tone="danger">{error}</Txt> : null}
          {!checked ? <Txt tone="muted">Checking your account…</Txt> : null}
          {busy === "in" ? <Txt tone="muted">Waiting for Google sign-in…</Txt> : null}
        </View>
        {accountError === "cloud_account" && !error ? (
          <Button label="Check account again" onPress={() => void cloudSession.refresh()} />
        ) : null}
        {checked ? (
          !account.configured ? (
            <Txt tone="muted">Cloud is unavailable in this build.</Txt>
          ) : account.signedIn ? (
            <>
              {account.account ? (
                <Group>
                  <Row title={account.account.user.name} detail={account.account.user.email} last />
                </Group>
              ) : (
                <Txt tone="muted">Cloud account is offline.</Txt>
              )}
              <Button
                label="Open Cloud Needs you"
                kind="primary"
                onPress={() => router.push("/cloud-needs-you")}
                disabled={busy !== null}
              />
              {Platform.OS === "ios" ? (
                <>
                  <Section title="Notifications" />
                  <Group>
                    <Row
                      title="Cloud push permission"
                      detail={pushLabel}
                      right={
                        pushLabel === "Not requested" ? (
                          <Button
                            label="Enable"
                            a11y="Enable Cloud notifications"
                            disabled={pushBusy || cell?.readOnly !== false}
                            onPress={() => void usePush.getState().refresh(true)}
                          />
                        ) : undefined
                      }
                      last
                    />
                  </Group>
                </>
              ) : null}
              <Button
                label={busy === "out" ? "Signing out…" : "Sign out"}
                disabled={!account.sessionId || busy !== null}
                onPress={() => void run("out")}
              />
            </>
          ) : (
            <>
              <Button
                label="Continue with Google"
                kind="primary"
                disabled={busy !== null}
                onPress={() => void run("in")}
              />
              {busy === "in" ? (
                <Button label="Cancel sign-in" onPress={() => cloudSession.cancelSignIn()} />
              ) : null}
            </>
          )
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { paddingHorizontal: 16, gap: 12 },
});
