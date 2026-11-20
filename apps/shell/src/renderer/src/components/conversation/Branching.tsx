// S3: branch a chat from one of its messages, or edit a sent message in a new branch.
import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { BranchPoint, BranchPreview } from "../../../../shared/branches";
import type { BotMessage, BotProfile } from "../../data";
import { t } from "../../i18n";
import { Dialog } from "../../kit";
import "./branching.css";

export type BranchMode = "branch" | "edit";

interface Pending {
  message: BotMessage;
  mode: BranchMode;
  turnId: string;
  at: BranchPoint;
  attemptId: string;
}

/** A branch of a branch keeps one "(branch)" in its name. */
const BRANCH_SUFFIX = / \(branch\)$/;

/** Where a branch from `message` starts: before the owner's message, or after the turn. */
export function branchPoint(message: BotMessage, mode: BranchMode): BranchPoint {
  return mode === "edit" || message.author === "you" ? "before_user" : "after_turn";
}

/**
 * The chats branched from `botId`, keyed by the message each shows under: an edit's branch under
 * the owner's message it replaced, any other under the turn's last message.
 */
export function branchesByMessage(
  bots: readonly BotProfile[],
  botId: string | undefined,
  messages: readonly BotMessage[],
) {
  const byMessage = new Map<string, BotProfile[]>();
  if (!botId) return byMessage;
  const turns = new Map<string, { owner?: string; last?: string }>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const turn = turns.get(message.turnId) ?? {};
    if (message.author === "you" && !turn.owner) turn.owner = message.id;
    turn.last = message.id;
    turns.set(message.turnId, turn);
  }
  for (const bot of bots) {
    const origin = bot.branchedFrom;
    if (origin?.botId !== botId) continue;
    const turn = turns.get(origin.turnId);
    const at = origin.at === "before_user" ? (turn?.owner ?? turn?.last) : turn?.last;
    if (at) byMessage.set(at, [...(byMessage.get(at) ?? []), bot]);
  }
  return byMessage;
}

/** A v4 UUID. `crypto.randomUUID` needs a secure context, which the renderer's page may not be. */
function attemptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Nothing comes before the chat's first message, so the daemon has no history to copy. Editing
 * that message starts a new chat instead.
 */
function startsFresh(preview: BranchPreview | undefined, mode: BranchMode | undefined): boolean {
  return mode === "edit" && preview?.reason === "copied_history_unavailable";
}

function previewText(preview: BranchPreview | undefined, mode?: BranchMode): string {
  if (!preview) return t("chat.branch.checking");
  if (startsFresh(preview, mode)) return t("chat.branch.fresh");
  if (preview.reason === "fork_requires_idle") return t("chat.branch.busy");
  if (!preview.available) return t("chat.branch.unavailable");
  if (preview.kind === "native") return t("chat.branch.native");
  return t("chat.branch.copied", { count: preview.copiedMessages });
}

/**
 * The branch dialog and its state. `open` starts it for a message; the dialog previews how the
 * branch is made, and for Edit holds the text, which becomes the new chat's draft.
 */
export function createBranching(deps: {
  bot: () => BotProfile | undefined;
  onOpenChat: (botId: string) => void;
  onDraft: (botId: string, text: string) => void;
}) {
  const [pending, setPending] = createSignal<Pending>();
  const [preview, setPreview] = createSignal<BranchPreview>();
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const textId = createUniqueId();

  function open(message: BotMessage, mode: BranchMode) {
    const bot = deps.bot();
    if (!bot || !message.turnId) return;
    const next: Pending = {
      message,
      mode,
      turnId: message.turnId,
      at: branchPoint(message, mode),
      attemptId: attemptId(),
    };
    setPending(next);
    setPreview(undefined);
    setText(mode === "edit" ? message.body : "");
    setError("");
    void window.openbot.agent
      .branchPreview({ botId: bot.id, turnId: next.turnId, at: next.at })
      .then((result) => pending() === next && setPreview(result))
      .catch(() => pending() === next && setPreview({ ...UNAVAILABLE }));
  }

  async function confirm() {
    const current = pending();
    const bot = deps.bot();
    if (!current || !bot) return;
    setBusy(true);
    setError("");
    try {
      if (startsFresh(preview(), current.mode)) {
        const created = await window.openbot.agent.createBot({
          projectId: bot.projectId ?? null,
          ...(bot.profileId ? { profileId: bot.profileId } : {}),
        });
        deps.onDraft(created.id, text());
        setPending(undefined);
        deps.onOpenChat(created.id);
        return;
      }
      const result = await window.openbot.agent.branch({
        botId: bot.id,
        turnId: current.turnId,
        at: current.at,
        title: t("chat.branch.title", { chat: bot.name.replace(BRANCH_SUFFIX, "") }),
        attemptId: current.attemptId,
      });
      if (result.failed) {
        // That attempt is over; the next try starts a new one.
        setPending({ ...current, attemptId: attemptId() });
        setError(t("chat.branch.failed"));
        return;
      }
      if (!result.ready || !result.botId) {
        setError(t("chat.branch.notConfirmed"));
        return;
      }
      if (current.mode === "edit") deps.onDraft(result.botId, text());
      setPending(undefined);
      deps.onOpenChat(result.botId);
    } catch {
      setError(t("chat.branch.failed"));
    } finally {
      setBusy(false);
    }
  }

  function view() {
    return (
      <Show when={pending()}>
        {(current) => (
          <Dialog
            title={t(
              current().mode === "edit" ? "chat.branch.editTitle" : "chat.branch.dialogTitle",
            )}
            busy={busy()}
            width={460}
            onClose={() => setPending(undefined)}
            actions={
              <>
                <button
                  type="button"
                  class="zb-kit-button"
                  disabled={busy()}
                  onClick={() => setPending(undefined)}
                >
                  {t("chat.branch.cancel")}
                </button>
                <button
                  type="button"
                  class="zb-kit-button primary"
                  disabled={
                    busy() ||
                    !(preview()?.available || startsFresh(preview(), current().mode)) ||
                    (current().mode === "edit" && !text().trim())
                  }
                  aria-busy={busy() || undefined}
                  onClick={() => void confirm()}
                >
                  {error()
                    ? t("chat.branch.retry")
                    : t(
                        current().mode === "edit"
                          ? "chat.branch.sendInBranch"
                          : "chat.branch.confirm",
                      )}
                </button>
              </>
            }
          >
            <p class="branch-preview" aria-live="polite">
              {previewText(preview(), current().mode)}
            </p>
            <Show when={current().mode === "edit"}>
              <label class="zb-kit-field-label" for={textId}>
                {t("chat.branch.message")}
              </label>
              <textarea
                id={textId}
                class="zb-kit-input branch-text"
                rows={4}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
              />
            </Show>
            <Show when={error()}>
              <p class="branch-error" role="alert">
                {error()}
              </p>
            </Show>
          </Dialog>
        )}
      </Show>
    );
  }

  return { open, view };
}

const UNAVAILABLE: BranchPreview = {
  available: false,
  kind: "native",
  copiedMessages: 0,
  omittedMessages: 0,
  reason: "",
};

/** In a branched chat: where it came from, linking back. */
export function BranchBanner(props: {
  bot: BotProfile | undefined;
  bots: readonly BotProfile[];
  onOpenChat: (botId: string) => void;
}) {
  const source = () => {
    const origin = props.bot?.branchedFrom;
    return origin ? props.bots.find((bot) => bot.id === origin.botId) : undefined;
  };
  return (
    <Show when={source()}>
      {(chat) => (
        <p class="branch-banner">
          {t("chat.branch.from")}{" "}
          <button type="button" class="branch-link" onClick={() => props.onOpenChat(chat().id)}>
            {chat().name}
          </button>
        </p>
      )}
    </Show>
  );
}

/** On the message a branch starts from: "2 branches", opening a list of them. */
export function BranchList(props: {
  branches: readonly BotProfile[];
  onOpenChat: (botId: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const listId = createUniqueId();
  return (
    <Show when={props.branches.length}>
      <div class="branch-list">
        <button
          type="button"
          class="branch-count"
          aria-expanded={open()}
          aria-controls={listId}
          onClick={() => setOpen(!open())}
        >
          {t("chat.branch.count", { count: props.branches.length })}
        </button>
        <ul id={listId} hidden={!open()}>
          <For each={props.branches}>
            {(branch) => (
              <li>
                <button
                  type="button"
                  class="branch-link"
                  onClick={() => props.onOpenChat(branch.id)}
                >
                  {branch.name}
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
