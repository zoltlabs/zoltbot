import { randomUUID } from "node:crypto";
import { protocolVersion } from "@zoltbot/protocol";
import WebSocket from "ws";

/** One explicit OS action uses the normal authenticated, version fenced human route. */
export function answerNotification(
  info: { url: string; token: string },
  request: { id: string; version: number },
  choice: "allow_once" | "reject_once",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(info.url);
    let finished = false,
      answered = false;
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      if (ok) resolve();
      else reject(new Error("notification_action_failed"));
    };
    const timer = setTimeout(() => finish(false), 5000);
    timer.unref();
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "hello",
          params: { protocolVersion, token: info.token },
        }),
      ),
    );
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.error) {
          finish(false);
          return;
        }
        if (message.id === 1 && message.result && !answered) {
          answered = true;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "interaction.answer",
              commandId: randomUUID(),
              params: {
                id: request.id,
                version: request.version,
                answer: {
                  action: "accept",
                  choice,
                  by: { kind: "human", id: "local-owner" },
                  at: new Date().toISOString(),
                },
              },
            }),
          );
        } else if (message.id === 2) finish(message.result?.state === "answered");
      } catch {
        finish(false);
      }
    });
  });
}
