import type { Page } from "@playwright/test";

/** A second authenticated desktop client, without exposing its connection token to the test log. */
export async function rpc(
  page: Page,
  method: string,
  params: unknown,
  commandId?: string,
): Promise<unknown> {
  return page.evaluate(
    async ({ method, params, commandId }) => {
      if (!window.zoltDesktop) throw new Error("fixture_desktop_missing");
      const info = await window.zoltDesktop.connection();
      const socket = new WebSocket(info.url);
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.close();
            reject(new Error("fixture_rpc_timeout"));
          }, 10000);
          const fail = () => {
            clearTimeout(timer);
            reject(new Error("fixture_rpc_failed"));
          };
          socket.addEventListener("error", fail, { once: true });
          socket.addEventListener(
            "open",
            () =>
              socket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "hello",
                  params: { protocolVersion: 1, token: info.token },
                }),
              ),
            { once: true },
          );
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.error) {
              clearTimeout(timer);
              reject(new Error(String(message.error.message)));
            } else if (message.id === 1)
              socket.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method,
                  params,
                  ...(commandId ? { commandId } : {}),
                }),
              );
            else if (message.id === 2) {
              clearTimeout(timer);
              resolve(message.result);
            }
          });
        });
      } finally {
        socket.close();
      }
    },
    { method, params, commandId },
  );
}
