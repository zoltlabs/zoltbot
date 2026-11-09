import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useClient, useLink } from "../state/link";
import { mono, sans, useTheme } from "../theme";
import { dark } from "../theme/tokens.generated";
import { Icon, Logo } from "../ui/icons";
import { Button, Txt } from "../ui/kit";

type Step = "scan" | "enter" | "confirm";

/** Pairing (D124): scan the Mac's QR code, then check the code on both screens and Allow on the Mac. */
export default function Pair() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>("scan");
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const { status, confirmCode, error, kind } = useClient((state) => state);
  const macName = useLink((state) => state.macName);

  useEffect(() => {
    // The relay client reaches online only after the person allowed this phone on the Mac.
    if (step === "confirm" && status === "online") router.replace("/");
  }, [step, status]);

  const start = async (text: string) => {
    setProblem("");
    try {
      await useLink.getState().pair(text);
      setStep("confirm");
    } catch (reason) {
      scanned.current = false;
      setProblem(reason instanceof Error ? reason.message : "That code did not work.");
    }
  };
  const cancel = () => {
    void useLink.getState().disconnect();
    scanned.current = false;
    setStep("scan");
  };
  const sample = async () => {
    await useLink.getState().showSample();
    router.replace("/");
  };

  const code = confirmCode ? `${confirmCode.slice(0, 3)} ${confirmCode.slice(3)}` : "";
  const failed = step === "confirm" && kind === "relay" && error && status === "offline";
  return (
    <View
      style={[
        styles.page,
        {
          backgroundColor: c["bg-page"],
          paddingTop: insets.top + 40,
          paddingBottom: insets.bottom + 16,
        },
      ]}
    >
      <View style={styles.logo}>
        <Logo />
      </View>
      {step === "confirm" ? (
        <>
          <Txt v="largeTitle" accessibilityRole="header" style={styles.center}>
            Confirm on your Mac
          </Txt>
          <Txt tone="secondary" style={styles.lede}>
            {`Check that this code matches the one on ${macName || "your Mac"}, then click Allow there.`}
          </Txt>
          <View
            style={[styles.codeBox, { backgroundColor: c["bg-sunken"], borderColor: c.border }]}
          >
            {code ? (
              <Txt style={[styles.code, { color: c.text }]} accessibilityRole="text">
                {code}
              </Txt>
            ) : (
              <ActivityIndicator
                color={c["accent-text"]}
                accessibilityLabel="Connecting to your Mac"
              />
            )}
          </View>
          <View style={styles.waiting} accessibilityLiveRegion="polite">
            {failed ? (
              <Txt tone="danger" style={styles.center}>
                {error}
              </Txt>
            ) : (
              <>
                <ActivityIndicator size="small" color={c["accent-text"]} />
                <Txt tone="muted">
                  {status === "mac_offline" ? "Your Mac is offline" : "Waiting for your Mac"}
                </Txt>
              </>
            )}
          </View>
        </>
      ) : (
        <>
          <Txt v="largeTitle" accessibilityRole="header" style={styles.center}>
            Pair with your Mac
          </Txt>
          <Txt tone="secondary" style={styles.lede}>
            On your Mac, open Zoltbot, go to Settings › Devices and choose Pair a phone. Then scan
            the code it shows.
          </Txt>
          {step === "scan" ? (
            <View style={[styles.scanner, { backgroundColor: c["gray-1"] }]}>
              {permission?.granted ? (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    if (scanned.current) return;
                    scanned.current = true;
                    void start(data);
                  }}
                  accessibilityLabel="Camera, point it at the QR code on your Mac"
                />
              ) : null}
              {permission?.granted ? (
                <View style={[styles.frame, { borderColor: dark.text }]} pointerEvents="none" />
              ) : null}
              {permission?.granted ? (
                <Txt v="meta" style={[styles.hint, { color: dark["text-secondary"] }]}>
                  Point at the QR code
                </Txt>
              ) : (
                <View style={styles.permission}>
                  <Txt v="meta" style={{ color: dark["text-secondary"], textAlign: "center" }}>
                    {permission?.canAskAgain === false
                      ? "Camera access is off. Turn it on in Settings, or enter the code instead."
                      : "Zoltbot needs the camera to read the code."}
                  </Txt>
                  {permission?.canAskAgain !== false ? (
                    <Button
                      label="Allow the camera"
                      kind="primary"
                      onPress={() => void requestPermission()}
                    />
                  ) : null}
                </View>
              )}
            </View>
          ) : (
            <View style={styles.enter}>
              <Txt v="meta" tone="secondary">
                Pairing link
              </Txt>
              <TextInput
                value={link}
                onChangeText={setLink}
                placeholder="zoltbot://pair?…"
                placeholderTextColor={c["text-dim"]}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Pairing link"
                style={[
                  styles.input,
                  {
                    color: c.text,
                    borderColor: c["border-strong"],
                    backgroundColor: c["bg-raised"],
                  },
                ]}
              />
              <Button
                label="Pair"
                kind="primary"
                disabled={!link.trim()}
                onPress={() => void start(link)}
              />
            </View>
          )}
          {problem ? (
            <Txt tone="danger" style={styles.center} accessibilityRole="text">
              {problem}
            </Txt>
          ) : null}
          <Button
            kind="plain"
            label={step === "scan" ? "Enter the code instead" : "Scan the code instead"}
            onPress={() => setStep(step === "scan" ? "enter" : "scan")}
            style={styles.switch}
          />
        </>
      )}
      <View style={styles.footer}>
        <View style={styles.note}>
          <Icon name="lock" size={18} color={c["text-muted"]} />
          <Txt v="meta" tone="muted" style={styles.flex}>
            Your phone and Mac talk end to end encrypted. The relay that connects them cannot read
            your work.
          </Txt>
        </View>
        {step === "confirm" ? (
          <Button label="Cancel" onPress={cancel} style={styles.big} />
        ) : (
          <Button label="Try it with sample data" onPress={sample} style={styles.big} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24 },
  logo: { alignItems: "center", marginBottom: 28 },
  center: { textAlign: "center" },
  lede: { textAlign: "center", marginTop: 10, marginHorizontal: 8 },
  scanner: {
    marginTop: 32,
    alignSelf: "center",
    width: 270,
    height: 270,
    borderRadius: 24,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    position: "absolute",
    top: 40,
    left: 40,
    right: 40,
    bottom: 40,
    borderRadius: 12,
    borderWidth: 4,
  },
  hint: { position: "absolute", bottom: 14 },
  permission: { position: "absolute", left: 20, right: 20, gap: 12, alignItems: "stretch" },
  enter: { marginTop: 32, gap: 8 },
  input: {
    fontFamily: sans,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  switch: { marginTop: 12, alignSelf: "center" },
  codeBox: {
    marginTop: 32,
    minHeight: 88,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  code: { fontFamily: mono, fontSize: 36, lineHeight: 44, fontWeight: "500", letterSpacing: 4 },
  waiting: {
    marginTop: 20,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: { marginTop: "auto", gap: 16 },
  note: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  flex: { flex: 1 },
  big: { minHeight: 50 },
});
