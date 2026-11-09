import { parse, WakeSchema } from "@zoltbot/protocol";
import { router } from "expo-router";
import { Linking, View } from "react-native";
import type { Row } from "../data/transport";
import { useAction } from "../state/actions";
import { Button, Txt } from "./kit";

/** Paired phones inspect and control the same durable waits as the Mac. */
export function WakeStatus({ rows, online }: { rows: Row[]; online: boolean }) {
  const { run, busy } = useAction();
  const wakes = rows
    .map((w) => parse(WakeSchema, w))
    .filter((w) => ["draft", "waiting", "ready", "needs_attention"].includes(w.status));
  return (
    <View style={{ gap: 12 }}>
      {wakes.map((w) => (
        <View key={w.id} style={{ gap: 8 }}>
          <Txt v="bodyMedium">
            {w.status === "draft"
              ? "Proposed wait"
              : w.status === "ready"
                ? "Ready · waiting for this chat to be idle"
                : w.status === "needs_attention"
                  ? "Wait needs attention"
                  : "Waiting for"}
          </Txt>
          <Txt>{w.label}</Txt>
          <Txt tone="muted">
            {w.behavior === "resume"
              ? `Then: ${w.continuation}`
              : "Then: bring this chat back to the inbox"}
          </Txt>
          <Txt tone="muted">Fallback: {new Date(w.fallbackAt).toLocaleString()}</Txt>
          <Txt tone="muted">
            Monitoring on your Mac while Zoltbot is running. Checks pause while it sleeps.
          </Txt>
          {w.lastCheckedAt ? (
            <Txt tone="muted">Last checked: {new Date(w.lastCheckedAt).toLocaleString()}</Txt>
          ) : null}
          {w.error ? <Txt>{w.error}</Txt> : null}
          {w.evidenceUrl ? (
            <Button
              label="View wake evidence"
              onPress={() => {
                const url = w.evidenceUrl ?? "";
                if (url.startsWith("#chat/"))
                  router.push(`/chat/${decodeURIComponent(url.slice(6))}`);
                else if (url.startsWith("https://github.com/")) void Linking.openURL(url);
              }}
            />
          ) : null}
          <View style={{ gap: 8 }}>
            {!w.itemId ? (
              <Button
                label={w.status === "draft" ? "Review and save" : "Edit wait"}
                disabled={busy || !online}
                onPress={() =>
                  router.push(
                    `/chat/wake?id=${encodeURIComponent(w.threadId)}&wakeId=${encodeURIComponent(w.id)}`,
                  )
                }
              />
            ) : null}
            {w.status !== "draft" && !w.itemId ? (
              <Button
                label={w.behavior === "resume" ? "Resume now" : "Bring back now"}
                disabled={busy || !online}
                onPress={() => {
                  void run("wake.resumeNow", { id: w.id, revision: w.revision });
                }}
              />
            ) : null}
            <Button
              label="Cancel wait"
              disabled={busy || !online}
              onPress={() => {
                void run("wake.cancel", { id: w.id, revision: w.revision });
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}
