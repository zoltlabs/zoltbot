import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import type { Client } from "../data/client";
import {
  approvalCategory,
  type PushResponse,
  pushActions,
  pushResponse,
  readPushTarget,
} from "../data/push";
import { owner } from "./actions";
import { useLink } from "./link";

// Notification actions. Category "approval" carries Allow once and Reject buttons that answer
// the interaction from the lock screen; a plain tap opens the thread.

export async function registerNotificationCategories() {
  await Notifications.setNotificationCategoryAsync(approvalCategory, [
    {
      identifier: pushActions.allow,
      buttonTitle: "Allow once",
      // Widening what the agent may do needs an unlocked phone.
      options: { opensAppToForeground: false, isAuthenticationRequired: true },
    },
    {
      identifier: pushActions.reject,
      buttonTitle: "Reject",
      textInput: { submitButtonTitle: "Reject", placeholder: "Tell the agent why (optional)" },
      options: { opensAppToForeground: false, isDestructive: true },
    },
  ]);
}

/** Resolves with the client once it is online, or undefined after the timeout. */
function onlineClient(timeoutMs: number): Promise<Client | undefined> {
  return new Promise((resolve) => {
    let stopClient: (() => void) | undefined;
    const finish = (client: Client | undefined) => {
      clearTimeout(timer);
      stopLink();
      stopClient?.();
      resolve(client);
    };
    const watch = (client: Client | undefined) => {
      stopClient?.();
      stopClient = undefined;
      if (!client) return;
      if (client.getState().status === "online") return finish(client);
      stopClient = client.subscribe((state) => {
        if (state.status === "online") finish(client);
      });
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const stopLink = useLink.subscribe((state, previous) => {
      if (state.client !== previous.client) watch(state.client);
    });
    watch(useLink.getState().client);
  });
}

async function tell(title: string, body: string, threadId?: string) {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, ...(threadId ? { data: { threadId } } : {}) },
    trigger: null,
  }).catch(() => undefined);
}

async function answerFromPush(response: Extract<PushResponse, { kind: "answer" }>) {
  const client = await onlineClient(20_000);
  if (!client) {
    await tell(
      "Answer not sent",
      "Your Mac could not be reached. Open the chat to answer.",
      response.threadId,
    );
    return;
  }
  try {
    await client.getState().call("interaction.answer", {
      id: response.id,
      version: response.version,
      answer: { ...response.answer, by: owner, at: new Date().toISOString() },
    });
  } catch {
    await tell(
      "Answer not sent",
      "The request changed or was already answered. Open the chat to check.",
      response.threadId,
    );
  }
}

const handled = new Set<string>();
export function handleNotificationResponse(response: Notifications.NotificationResponse) {
  const content = response.notification.request.content;
  const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (handled.has(key)) return;
  handled.add(key);
  const next = pushResponse(
    readPushTarget({ categoryIdentifier: content.categoryIdentifier, data: content.data }),
    response.actionIdentifier,
    response.userText,
  );
  if (next.kind === "open") router.push(`/chat/${next.threadId}`);
  if (next.kind === "answer") void answerFromPush(next);
}

/** Registers the category and listens for taps and action buttons. Returns a cleanup. */
export function startNotificationActions(): () => void {
  void registerNotificationCategories().catch(() => undefined);
  const subscription = Notifications.addNotificationResponseReceivedListener(
    handleNotificationResponse,
  );
  try {
    // A tap that launched the app arrives before the listener exists.
    const last = Notifications.getLastNotificationResponse();
    if (last) {
      handleNotificationResponse(last);
      Notifications.clearLastNotificationResponse();
    }
  } catch {
    /* Older native modules: nothing to replay. */
  }
  return () => subscription.remove();
}
