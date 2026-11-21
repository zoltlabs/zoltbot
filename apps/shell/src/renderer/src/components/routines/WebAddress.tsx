// R2: a web-address routine's Copy, Send test and Rotate, for the Routines page's Actions menu.
import { createSignal } from "solid-js";
import type { RoutineItem } from "../../../../shared/routines";
import { t } from "../../i18n";
import { ConfirmDialog, type MenuItem } from "../../kit";
import { errorText } from "./routine-format";

type Action = "copy" | "test" | "rotate";

const CODES: Record<string, Parameters<typeof t>[0]> = {
  web_address_sign_in: "routines.web.signIn",
  web_address_busy: "routines.web.busy",
  web_address_test_failed: "routines.web.testFailed",
  web_address_elsewhere: "routines.web.elsewhere",
  web_address_missing: "routines.web.missing",
};

const DONE = {
  copied: "routines.web.copied",
  sent: "routines.web.sent",
  rotated: "routines.web.rotated",
} as const;

/** The words for what happened, or for why it didn't. */
export async function webAddress(item: RoutineItem, action: Action): Promise<string> {
  const run = window.openbot.routines.webAddress;
  if (!run) throw new Error(t("routines.failed"));
  try {
    const { state } = await run({ id: item.id, action });
    if (state === "elsewhere") throw new Error("web_address_elsewhere");
    return t(DONE[state], { name: item.name });
  } catch (failure) {
    const key = CODES[errorText(failure)];
    throw new Error(key ? t(key) : t("routines.web.failed"));
  }
}

/** Menu items for a routine started by its web address; none when the app can't reach them. */
export function webAddressMenu(
  item: RoutineItem,
  act: (action: Action) => void,
  rotate: () => void,
): MenuItem[][] {
  if (item.trigger?.kind !== "webhook.received" || !window.openbot.routines.webAddress) return [];
  return [
    [
      { id: "web-copy", label: t("routines.web.copy"), run: () => act("copy") },
      { id: "web-test", label: t("routines.web.test"), run: () => act("test") },
      { id: "web-rotate", label: t("routines.web.rotate"), run: rotate },
    ],
  ];
}

export function RotateDialog(props: {
  item: RoutineItem;
  onClose: () => void;
  onRotated: (status: string) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  async function confirm() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      props.onRotated(await webAddress(props.item, "rotate"));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ConfirmDialog
      title={t("routines.web.rotateTitle", { name: props.item.name })}
      body={t("routines.web.rotateBody", { name: props.item.name })}
      confirmLabel={t("routines.web.rotateConfirm")}
      busyLabel={t("routines.web.rotating")}
      danger
      busy={busy()}
      error={error()}
      onConfirm={() => void confirm()}
      onCancel={props.onClose}
    />
  );
}
