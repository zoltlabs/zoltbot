import { expect, test } from "@playwright/test";
import { launch } from "./desktop.js";

test("preserves a stale draft and shows another client's resolution without overwriting it", async () => {
  const fixture = await launch("chat"),
    { page } = fixture;
  try {
    await page.addInitScript(() => {
      const state = window as unknown as {
        holdInteractionEvents: boolean;
        releaseInteractionEvents(): void;
      };
      const held: { socket: WebSocket; data: string }[] = [];
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (event) => {
            if (state.holdInteractionEvents && JSON.parse(String(event.data)).method === "event") {
              event.stopImmediatePropagation();
              held.push({ socket: this, data: String(event.data) });
            }
          });
        }
      };
      state.releaseInteractionEvents = () => {
        state.holdInteractionEvents = false;
        for (const event of held.splice(0))
          event.socket.dispatchEvent(new MessageEvent("message", { data: event.data }));
      };
    });
    await page.reload();
    await expect(page.getByText("Connected to local daemon", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Chat verification/ }).click();
    const editor = page.getByRole("textbox", { name: "Message Builder" });
    await editor.fill("approval");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Needs you", exact: true }).click();
    const card = page.getByRole("article", { name: "approval from Builder", exact: true });
    await card.getByRole("button", { name: "More", exact: true }).click();
    await card.getByRole("menuitem", { name: /Decline with a reason/ }).click();
    const feedback = card.getByRole("textbox", { name: "Feedback", exact: true });
    await feedback.fill("Keep this exact stale draft.");
    await page.evaluate(async () => {
      (window as unknown as { holdInteractionEvents: boolean }).holdInteractionEvents = true;
      if (!window.zoltDesktop) throw new Error("fixture_desktop_missing");
      const info = await window.zoltDesktop.connection();
      const socket = new WebSocket(info.url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("fixture_client_failed")), {
          once: true,
        });
      });
      let id = 0;
      const pending = new Map<
        number,
        { resolve(value: Record<string, unknown>): void; reject(error: Error): void }
      >();
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)),
          waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error("fixture_request_failed"));
        else waiter.resolve(message.result);
      });
      const call = (method: string, params: unknown, commandId?: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const key = ++id;
          pending.set(key, { resolve, reject });
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: key,
              method,
              params,
              ...(commandId ? { commandId } : {}),
            }),
          );
        });
      try {
        await call("hello", { protocolVersion: 1, token: info.token });
        const snapshot = await call("snapshot.get", {}),
          entities = snapshot.entities as Record<string, Record<string, unknown>[]>;
        const request = entities.interaction?.find(
          (request) => request.state === "pending" && request.type === "approval",
        );
        if (!request) throw new Error("fixture_request_missing");
        await call(
          "interaction.answer",
          {
            id: request.id,
            version: request.version,
            answer: {
              action: "accept",
              choice: "allow_once",
              device: "Second client",
              by: { kind: "human", id: "other" },
              at: new Date().toISOString(),
            },
          },
          "other-client-answer",
        );
      } finally {
        socket.close();
      }
    });
    await card.getByRole("button", { name: /^Decline N$/ }).click();
    await expect(card.getByRole("alert")).toContainText("answered elsewhere");
    await expect(feedback).toHaveValue("Keep this exact stale draft.");
    await page.evaluate(() =>
      (window as unknown as { releaseInteractionEvents(): void }).releaseInteractionEvents(),
    );
    await expect(card.getByRole("heading", { name: "Answered", exact: true })).toBeVisible();
    await expect(card).toContainText("Second client");
    await expect(card).toContainText("allow once");
    await expect(card).not.toContainText("Keep this exact stale draft.");
  } finally {
    await fixture.cleanup();
  }
});
