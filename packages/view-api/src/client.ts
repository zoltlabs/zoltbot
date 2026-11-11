import type { Static } from "@sinclair/typebox";
import type { callSchemas, ReadySchema } from "./bridge.js";
import type { Permission } from "./manifest.js";
import type { Topic, TopicValues } from "./topics.js";

type Input<K extends keyof typeof callSchemas> = Static<(typeof callSchemas)[K]>;
export interface ZoltClient {
  ready: Promise<Static<typeof ReadySchema>>;
  readonly granted: readonly Permission[];
  subscribe(
    topics: Topic[],
    callback: (topic: Topic, value: TopicValues[Topic]) => void,
  ): () => void;
  on(
    name: "theme" | "grants" | "shortcut" | "visibility",
    callback: (value: unknown) => void,
  ): () => void;
  app: { open(target: Input<"app.open">): Promise<void> };
  storage: { get(): Promise<unknown>; set(value: unknown): Promise<void> };
  chats: {
    send(
      input: Input<"chats.send">,
    ): Promise<{ chatId: string; result: "started" | "queued" | "skipped"; reason?: string }[]>;
    interrupt(
      input: Input<"chats.interrupt">,
    ): Promise<{ chatId: string; result: "interrupted" | "skipped"; reason?: string }[]>;
  };
  requests: { answer(input: Input<"requests.answer">): Promise<void> };
}
