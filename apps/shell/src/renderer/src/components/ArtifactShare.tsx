// S1: Share in the artifact panel. Publishes the open version as a private or public link,
// copies it, switches who can open it, replaces an older link, or takes it down.
import { createEffect, createSignal, on, Show } from "solid-js";
import type {
  ArtifactLink,
  ArtifactShareState,
  ArtifactShareTarget,
  ArtifactShareWork,
  ArtifactVisibility,
} from "../../../shared/artifact-share";
import { t } from "../i18n";
import { ConfirmDialog, Popover, showToast } from "../kit";
import { memoryError } from "../memory-store";
import "../memory.css";
import "../artifact-share.css";

type Action = "publish" | "visibility" | "replace" | "unpublish" | "signIn";
type Pending = "public" | "replace" | "unpublish";

export function ArtifactShare(props: { artifactId: string; manifestHash: string; title: string }) {
  const [state, setState] = createSignal<ArtifactShareState | null>(null);
  const [open, setOpen] = createSignal(false);
  const [choice, setChoice] = createSignal<ArtifactVisibility>("private");
  const [busy, setBusy] = createSignal<Action | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal<Pending | null>(null);
  let button: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;
  const target = (): ArtifactShareTarget => ({
    artifactId: props.artifactId,
    manifestHash: props.manifestHash,
    title: props.title,
  });
  /** Each version change starts a new generation; answers for an older one are dropped. */
  let generation = 0;

  createEffect(
    on(
      () => `${props.artifactId}:${props.manifestHash}`,
      () => {
        const current = ++generation;
        setOpen(false);
        setPending(null);
        setBusy(null);
        setError(null);
        setState(null);
        window.openbot.share.status(target()).then(
          (next) => current === generation && setState(next),
          () => current === generation && setState({ kind: "unavailable" }),
        );
      },
    ),
  );

  const link = () => {
    const current = state();
    return current?.kind === "ready" ? current.link : null;
  };

  /** Moves focus to the popover's main control once the changed content has rendered. */
  function refocus() {
    setTimeout(() => {
      const main = body?.querySelector("button.primary") ?? body?.querySelector("button");
      if (main instanceof HTMLElement) main.focus();
    }, 0);
  }

  async function run(action: Action, work: ArtifactShareWork, done?: string) {
    if (busy()) return false;
    const current = generation;
    setBusy(action);
    setError(null);
    try {
      const next = await work(target());
      if (current !== generation) return false;
      setState({ kind: "ready", link: next });
      setPending(null);
      if (done) showToast({ message: done });
      refocus();
      return true;
    } catch (failure) {
      if (current === generation) setError(memoryError(failure));
      return false;
    } finally {
      if (current === generation) setBusy(null);
    }
  }

  const publish = (visibility: ArtifactVisibility) =>
    run("publish", (item) => window.openbot.share.publish({ ...item, visibility }));
  const setVisibility = (visibility: ArtifactVisibility) =>
    run("visibility", (item) => window.openbot.share.setVisibility({ ...item, visibility }));

  function choosePublish() {
    if (choice() === "public") setPending("public");
    else void publish("private");
  }

  function switchTo(visibility: ArtifactVisibility, current: ArtifactLink) {
    if (busy() || visibility === current.visibility) return;
    if (visibility === "public") setPending("public");
    else void setVisibility("private");
  }

  function confirm() {
    const action = pending();
    if (action === "unpublish")
      void run(
        "unpublish",
        async (item) => {
          await window.openbot.share.unpublish(item);
          return null;
        },
        t("share.unpublished"),
      );
    else if (action === "replace")
      void run("replace", (item) => window.openbot.share.replace(item));
    else if (link()) void setVisibility("public");
    else void publish("public");
  }

  async function signIn() {
    if (busy()) return;
    const current = generation;
    setBusy("signIn");
    setError(null);
    try {
      await window.openbot.account.signIn();
      const next = await window.openbot.share.status(target());
      if (current !== generation) return;
      setState(next);
      refocus();
    } catch (failure) {
      if (current === generation) setError(memoryError(failure));
    } finally {
      if (current === generation) setBusy(null);
    }
  }

  async function copy() {
    setError(null);
    try {
      await window.openbot.share.copy(target());
      showToast({ message: t("share.copied") });
    } catch (failure) {
      setError(memoryError(failure));
    }
  }

  const label = (action: Action, idle: string, working: string) =>
    busy() === action ? working : idle;

  const visibilityGroup = (
    value: () => ArtifactVisibility,
    onPick: (next: ArtifactVisibility) => void,
  ) => (
    <fieldset class="memory-views artifact-share-choice">
      <legend class="sr-only">{t("share.who")}</legend>
      <button
        type="button"
        class="memory-view"
        aria-pressed={value() === "private"}
        aria-disabled={busy() !== null}
        onClick={() => onPick("private")}
      >
        {t("share.private")}
      </button>
      <button
        type="button"
        class="memory-view"
        aria-pressed={value() === "public"}
        aria-disabled={busy() !== null}
        onClick={() => onPick("public")}
      >
        {t("share.public")}
      </button>
    </fieldset>
  );

  const dialog = () => {
    const action = pending();
    if (action === "unpublish")
      return {
        title: t("share.unpublishTitle", { title: props.title }),
        body: t("share.unpublishBody"),
        confirm: t("share.unpublish"),
        busy: t("share.unpublishing"),
      };
    if (action === "replace")
      return {
        title: t("share.replaceTitle"),
        body: t("share.replaceBody"),
        confirm: t("share.replaceConfirm"),
        busy: t("share.publishing"),
      };
    return {
      title: t("share.publicTitle", { title: props.title }),
      body: t("share.publicBody"),
      confirm: t("share.publicConfirm"),
      busy: t("share.publishing"),
    };
  };

  return (
    <Show when={state() && state()?.kind !== "unavailable"}>
      <button
        ref={button}
        type="button"
        class="zb-kit-button artifact-share-button"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        {t("share.button")}
      </button>
      <Show when={open() && button}>
        {(anchor) => (
          <Popover
            anchor={anchor()}
            label={t("share.title", { title: props.title })}
            width={300}
            // A press on the confirm dialog's backdrop closes the dialog, not the popover too.
            onClose={() => !pending() && setOpen(false)}
          >
            <div ref={body} class="artifact-share" aria-busy={busy() !== null}>
              <Show
                when={state()?.kind === "ready"}
                fallback={
                  <button
                    type="button"
                    class="zb-kit-button primary"
                    aria-disabled={busy() !== null}
                    onClick={() => void signIn()}
                  >
                    {label("signIn", t("share.signIn"), t("share.signingIn"))}
                  </button>
                }
              >
                <Show
                  when={link()}
                  fallback={
                    <>
                      {visibilityGroup(choice, setChoice)}
                      <button
                        type="button"
                        class="zb-kit-button primary"
                        aria-disabled={busy() !== null}
                        onClick={() => !busy() && choosePublish()}
                      >
                        {label("publish", t("share.publish"), t("share.publishing"))}
                      </button>
                    </>
                  }
                >
                  {(current) => (
                    <>
                      <input
                        class="zb-kit-input artifact-share-url"
                        readOnly
                        aria-label={t("share.link")}
                        value={current().url}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <div class="artifact-share-row">
                        <button
                          type="button"
                          class="zb-kit-button primary"
                          onClick={() => void copy()}
                        >
                          {t("share.copy")}
                        </button>
                        <Show when={current().current}>
                          {visibilityGroup(
                            () => current().visibility,
                            (next) => switchTo(next, current()),
                          )}
                        </Show>
                      </div>
                      <Show when={!current().current}>
                        <p class="artifact-share-older">{t("share.older")}</p>
                        <button
                          type="button"
                          class="zb-kit-button"
                          aria-disabled={busy() !== null}
                          onClick={() => !busy() && setPending("replace")}
                        >
                          {t("share.replace")}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="zb-kit-button artifact-share-unpublish"
                        aria-disabled={busy() !== null}
                        onClick={() => !busy() && setPending("unpublish")}
                      >
                        {t("share.unpublish")}
                      </button>
                    </>
                  )}
                </Show>
              </Show>
              <Show when={error() && !pending()}>
                <p class="memory-error" role="alert">
                  {error()}
                </p>
              </Show>
            </div>
          </Popover>
        )}
      </Show>
      <Show when={pending()}>
        <ConfirmDialog
          title={dialog().title}
          body={dialog().body}
          confirmLabel={dialog().confirm}
          busyLabel={dialog().busy}
          danger={pending() !== "public"}
          busy={busy() !== null}
          error={error()}
          onCancel={() => {
            setPending(null);
            setError(null);
          }}
          onConfirm={confirm}
        />
      </Show>
    </Show>
  );
}
