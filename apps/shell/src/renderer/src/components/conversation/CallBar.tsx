// O2: the bar above the composer during a call: who you're talking to, whether it's listening or
// speaking, how long the call has run, and Mute and End.
import { callDuration } from "@zoltbot/protocol";
import { createSignal, onCleanup, Show } from "solid-js";
import type { BotProfile } from "../../data";
import { t } from "../../i18n";
import { ConfirmDialog } from "../../kit";
import { AgentAvatar } from "../AgentAvatar";
import { focusComposerEnd } from "./ask-about";
import { type CallView, callNotice, currentCall, endCall, toggleMute } from "./call";
import "./call.css";

export function CallBar(props: { call: CallView; bot: BotProfile }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const speaking = () => props.call.state === "speaking";
  const status = () =>
    speaking() ? t("call.speaking") : props.call.muted ? "" : t("call.listening");
  return (
    <section class="call-bar" aria-label={t("call.label")}>
      <AgentAvatar bot={props.bot} class="call-bar-avatar" />
      <div class="call-bar-who">
        <span class="call-bar-name">{props.bot.name}</span>
        <span class="call-bar-status">{status()}</span>
      </div>
      {/* Changes every second; screen readers skip it rather than hear "zero colon zero five". */}
      <span class="call-bar-time" aria-hidden="true">
        {callDuration(now() - props.call.startedAt)}
      </span>
      {/* Focus lands on the call's controls when it starts, which also says it started. */}
      <button
        ref={(el) => queueMicrotask(() => el.focus())}
        type="button"
        class="zb-kit-button"
        onClick={toggleMute}
      >
        {props.call.muted ? t("call.unmute") : t("call.mute")}
      </button>
      <button
        type="button"
        class="zb-kit-button danger"
        aria-keyshortcuts="Meta+Shift+V"
        onClick={() => {
          endCall();
          // The bar goes away; the composer gets focus instead of the page.
          requestAnimationFrame(focusComposerEnd);
        }}
      >
        {t("call.end")}
      </button>
    </section>
  );
}

/** The call bar while this chat is on a call, and the sheet before a first call. */
export function CallHost(props: { bot: BotProfile | null | undefined }) {
  return (
    <>
      <Show when={props.bot && currentCall()?.botId === props.bot.id && currentCall()}>
        {(call) => <CallBar call={call()} bot={props.bot as BotProfile} />}
      </Show>
      <CallNotice />
    </>
  );
}

/** Before the first call on a Mac whose speech recognition isn't on-device. */
function CallNotice() {
  return (
    <Show when={callNotice()}>
      {(answer) => (
        <ConfirmDialog
          title={t("call.start")}
          body={t("call.apple")}
          confirmLabel={t("call.start")}
          onConfirm={() => answer()(true)}
          onCancel={() => answer()(false)}
        />
      )}
    </Show>
  );
}
