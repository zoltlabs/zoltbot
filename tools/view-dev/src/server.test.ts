import { request } from "node:http";
import { expect, it } from "vitest";
import { serveView } from "./server.js";

it("serves checked view files and virtual host resources only on its loopback host", async () => {
  const server = await serveView("packages/view-api/examples/hello-view");
  try {
    const response = await fetch(server.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(new URL("/_host/v1/mock.js", server.url))).status).toBe(200);
    expect((await fetch(new URL("/outside.txt", server.url))).status).toBe(404);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(server.url, { headers: { Host: "example.invalid" } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      call.on("error", reject);
      call.end();
    });
    expect(status).toBe(404);
  } finally {
    await server.close();
  }
});
