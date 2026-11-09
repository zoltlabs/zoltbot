import type { Shipping } from "@zoltbot/protocol";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import type { Row } from "../data/transport";
import { useSnapshot } from "../state/link";
import { Button, Txt } from "./kit";
export function ShippingContext({ task }: { task: Row }) {
  const binding = useSnapshot().entities.shipping?.find((row) => row.taskId === task.id) as
    | Shipping
    | undefined;
  const [expanded, setExpanded] = useState(false);
  if (!binding?.snapshot) return null;
  const pr = binding.snapshot;
  return (
    <View style={{ gap: 8 }}>
      <Button
        label={`PR #${pr.number} · ${pr.state.toLowerCase()}${pr.draft ? " · Draft" : ""}`}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <>
          <Txt v="meta">
            {binding.repository} · {binding.branch} → {binding.baseBranch}
          </Txt>
          <Txt v="meta">
            Last updated {new Date(pr.fetchedAt).toLocaleString()}
            {binding.error ? " · Update unavailable" : ""}
          </Txt>
          <Txt v="meta">
            GitHub reports {pr.mergeState.toLowerCase()}. Required checks may be unavailable.
          </Txt>
          {pr.checks.slice(0, 20).map((check) => (
            <Txt key={check.id} v="meta">
              {check.name}: {check.state.toLowerCase()} · {check.sha.slice(0, 7)}
            </Txt>
          ))}
          <Txt v="meta">
            {pr.threads.filter((t) => !t.resolved).length} unresolved feedback items.{" "}
            {pr.complete ? "" : "Partial discussion loaded."}
          </Txt>
          <Button
            label="Open pull request on GitHub"
            onPress={() => {
              try {
                const url = new URL(pr.url);
                if (url.protocol === "https:" && url.hostname === "github.com")
                  void Linking.openURL(url.href);
              } catch {}
            }}
          />
          <Button
            label="Continue shipping on your Mac"
            onPress={() =>
              Alert.alert(
                "Continue on your Mac",
                `Open Tasks → ${String(task.title)} → Pull request to inspect diagnostics, send feedback, publish reviewed code or merge. Accepting the result does not merge its PR.`,
              )
            }
          />
        </>
      ) : null}
    </View>
  );
}
