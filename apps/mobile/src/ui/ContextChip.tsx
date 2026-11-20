import { useEffect, useState } from "react";
import { View } from "react-native";
import { type ContextUsage, contextPercent, contextTone, toContextUsage } from "../data/session";
import { t } from "../i18n";
import { useClient } from "../state/link";
import { Chip } from "./kit";

/**
 * How full the chat's context is, as a small chip in the chat header. Reads it when the chat
 * opens, when a turn ends and after a compaction; hidden when the agent doesn't report it.
 */
export function ContextChip({
  threadId,
  turnId,
  compactions,
}: {
  threadId: string;
  turnId: string | undefined;
  compactions: number;
}) {
  const call = useClient((state) => state.call);
  const online = useClient((state) => state.status === "online");
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: turnId and compactions are the reasons to read again.
  useEffect(() => {
    let live = true;
    setUsage(null);
    if (!online) return;
    call("session.context", { threadId })
      .then((value) => live && setUsage(toContextUsage(value)))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, [call, online, threadId, turnId, compactions]);
  if (!usage) return null;
  const percent = contextPercent(usage);
  return (
    <View accessible accessibilityLabel={t("chat.context.meter", { percent })}>
      <Chip label={`${percent}%`} tone={contextTone(usage)} />
    </View>
  );
}
