import type { ModelList } from "@zoltbot/adapters-sdk";
import { expect, it } from "vitest";
import { runtimeApi } from "./runtime-api.js";
import type { SessionManager } from "./session-manager.js";

/** A session manager whose runtime host lists models. */
const manager = (listModels: (definitionId: string) => Promise<ModelList>) =>
  ({ listModels }) as unknown as SessionManager;
const store = (definitions: { id: string; adapter: string; archived?: boolean }[]) =>
  ({ snapshot: () => ({ agentDefinition: definitions }) }) as never;

it("serves model.refresh and lists the results in model.catalog", async () => {
  const asked: string[] = [];
  const errors: string[] = [];
  const api = runtimeApi({
    store: store([
      { id: "claude", adapter: "claude" },
      { id: "cursor", adapter: "acp" },
      { id: "old", adapter: "codex", archived: true },
    ]),
    publish() {},
    onError: (code) => errors.push(code),
    manager: manager(async (definitionId) => {
      asked.push(definitionId);
      if (definitionId === "cursor") throw new Error("model_list_unavailable");
      return { list: [{ id: "opus", name: "Opus" }], effort: ["high"] };
    }),
  });
  const catalog = () =>
    (api("model.catalog", {}) as { items: { definitionId: string; models: unknown[] }[] }).items;
  expect(catalog().find((item) => item.definitionId === "claude")?.models).toEqual([]);

  expect(await api("model.refresh", { definitionId: "claude" })).toEqual({ ok: true });
  expect(catalog().find((item) => item.definitionId === "claude")?.models).toEqual([
    { id: "opus", name: "Opus" },
  ]);

  asked.length = 0;
  expect(await api("model.refresh", {})).toEqual({ ok: false });
  expect(asked.sort()).toEqual(["claude", "cursor"]);
  expect(errors).toEqual([]);
});

it("asks a provider once while a refresh is already running", async () => {
  let calls = 0;
  let finish!: () => void;
  const api = runtimeApi({
    store: store([{ id: "codex", adapter: "codex" }]),
    publish() {},
    manager: manager(() => {
      calls++;
      return new Promise((resolve) => {
        finish = () => resolve({ list: [], effort: [] });
      });
    }),
  });
  const first = api("model.refresh", { definitionId: "codex" }) as Promise<unknown>;
  const second = api("model.refresh", { definitionId: "codex" }) as Promise<unknown>;
  finish();
  expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
  expect(calls).toBe(1);
});

it("reports a failed listing without serving stale models", async () => {
  const errors: string[] = [];
  const api = runtimeApi({
    store: store([{ id: "claude", adapter: "claude" }]),
    publish() {},
    onError: (code) => errors.push(code),
    manager: manager(async () => {
      throw new Error("auth_required");
    }),
  });
  expect(await api("model.refresh", {})).toEqual({ ok: false });
  expect(errors).toEqual(["model_refresh_failed:auth_required"]);
});

it("answers model.refresh without a runtime", async () => {
  const api = runtimeApi({ store: store([{ id: "claude", adapter: "claude" }]), publish() {} });
  expect(await api("model.refresh", { definitionId: "claude" })).toEqual({ ok: false });
});
