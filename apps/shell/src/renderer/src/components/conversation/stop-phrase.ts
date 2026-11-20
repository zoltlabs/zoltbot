// C3: a bare "stop" sent while the agent works stops the turn instead of queueing the word.
import { isStopPhrase } from "@zoltbot/protocol";
import { t } from "../../i18n";
import { showToast } from "../../kit";

export function stopsTurn(text: string, attachmentCount: number, running: boolean): boolean {
  if (!running || attachmentCount > 0) return false;
  return isStopPhrase(text, t("chat.stop.phrases").split("|"));
}

/**
 * "send" when the message should go out as usual. Otherwise it stopped the turn, or tried and
 * failed (the stop shows its own error), and the message isn't sent. Only a turn with an id can
 * be interrupted; until then "stop" is an ordinary message.
 */
export async function stopInstead(
  text: string,
  attachmentCount: number,
  turnId: string | null | undefined,
  stop: () => Promise<boolean>,
): Promise<"send" | "stopped" | "failed"> {
  if (!stopsTurn(text, attachmentCount, Boolean(turnId))) return "send";
  if (!(await stop())) return "failed";
  showToast({ message: t("chat.stopped") });
  return "stopped";
}
