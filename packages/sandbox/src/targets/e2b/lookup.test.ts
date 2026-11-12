import { randomBytes } from "node:crypto";
import { Sandbox } from "e2b";
import { afterEach, expect, it, vi } from "vitest";
import { createE2bTarget, type E2bSdk, e2bSdk } from "./index.js";

afterEach(() => vi.restoreAllMocks());
const unused = async () => {
  throw new Error("unexpected_provider_operation");
};
it("looks up matching metadata without connecting or resuming a provider sandbox", async () => {
  let wanted: Record<string, string> = {};
  const sdk: E2bSdk = {
    create: unused,
    connect: unused,
    kill: unused,
    getInfo: unused,
    getMetrics: unused,
    list: async (labels) => {
      wanted = labels;
      return [
        { sandboxId: "mine", metadata: { org: "org", task: "task" } },
        { sandboxId: "foreign", metadata: { org: "other", task: "task" } },
        { sandboxId: "mine", metadata: { org: "org", task: "task" } },
      ];
    },
  };
  const target = createE2bTarget({ apiKey: randomBytes(32).toString("base64url"), sdk });
  expect(await target.find({ org: "org", task: "task" })).toEqual([
    { target: target.id, id: "mine", workdir: "/home/user" },
  ]);
  expect(wanted).toEqual({ org: "org", task: "task" });
  await expect(target.find({})).rejects.toMatchObject({ code: "invalid" });
});
it("uses bounded SDK pagination over running and paused resources", async () => {
  let pages = 0,
    query: unknown;
  vi.spyOn(Sandbox, "list").mockImplementation((options) => {
    query = options?.query;
    return {
      get hasNext() {
        return pages < 2;
      },
      async nextItems() {
        pages++;
        return [{ sandboxId: `sandbox-${pages}`, metadata: { task: "task" } }];
      },
    } as unknown as ReturnType<typeof Sandbox.list>;
  });
  expect(
    (await e2bSdk.list({ task: "task" }, { apiKey: randomBytes(32).toString("base64url") })).map(
      (row) => row.sandboxId,
    ),
  ).toEqual(["sandbox-1", "sandbox-2"]);
  expect(query).toEqual({ metadata: { task: "task" }, state: ["running", "paused"] });
  expect(pages).toBe(2);
});
it("fails a nonterminating provider paginator instead of returning an incomplete lookup", async () => {
  let pages = 0;
  vi.spyOn(Sandbox, "list").mockReturnValue({
    hasNext: true,
    async nextItems() {
      pages++;
      return [];
    },
  } as unknown as ReturnType<typeof Sandbox.list>);
  await expect(
    e2bSdk.list({ task: "task" }, { apiKey: randomBytes(32).toString("base64url") }),
  ).rejects.toMatchObject({ code: "provider", message: "Sandbox lookup limit exceeded" });
  expect(pages).toBe(16);
});
