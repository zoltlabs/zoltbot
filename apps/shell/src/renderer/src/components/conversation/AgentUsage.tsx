// S6: this chat's spend over the last 7 days, shown in its settings.
import { createResource, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { formatTokens, formatUsd, rangeDays, spendTotals } from "../../spend";

export function AgentUsage(props: { botId: string }) {
  const [totals, { refetch }] = createResource(
    () => props.botId,
    async (botId) => {
      const { from } = rangeDays("7d", new Date());
      const view = await window.openbot.spend.list({ from: from.toISOString() });
      return spendTotals(view.rows.filter((row) => row.botId === botId));
    },
  );
  const off = window.openbot.agent.onEvent((event) => {
    if (event.type === "spend-changed") void refetch();
  });
  onCleanup(off);

  const line = () => {
    const total = totals();
    if (!total) return "";
    if (total.costUsd > 0)
      return t(total.costKnown ? "usage.agent.cost" : "usage.agent.costAtLeast", {
        amount: formatUsd(total.costUsd),
      });
    if (total.tokens > 0) return t("usage.agent.tokens", { tokens: formatTokens(total.tokens) });
    return t("usage.agent.none");
  };

  return (
    <Show when={!totals.error && totals()}>
      <div class="agent-settings-model-row agent-settings-context-row">
        <span>{t("usage.title")}</span>
        <span class="agent-usage-line">{line()}</span>
      </div>
    </Show>
  );
}
