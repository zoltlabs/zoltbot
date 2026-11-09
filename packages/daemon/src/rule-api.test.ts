import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { ruleApi } from "./rule-api.js";

async function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/rules-"));
  const store = await openStore(path.join(root, "store.db"));
  const api = ruleApi({ store, publish() {}, now: () => "2026-10-28T12:00:00.000Z" });
  return {
    store,
    api,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const draft = {
  scope: "global",
  matcher: { tool: "execute", command: { prefix: ["git", "status"] } },
  decision: "allow",
};
it("creates and revokes a confirmed human rule with replay and durable audits", async () => {
  const test = await fixture();
  try {
    const result = test.api("rule.create", { rule: draft, confirmed: true }, "create") as {
      id: string;
    };
    expect(test.api("rule.create", { rule: draft, confirmed: true }, "create")).toEqual(result);
    expect(test.store.snapshot().rule).toHaveLength(1);
    expect(test.store.snapshot().audit).toHaveLength(1);
    expect(test.api("rule.list", {})).toMatchObject({
      items: [{ id: result.id, createdBy: { kind: "human", id: "local-owner" } }],
    });
    expect(test.api("rule.revoke", { id: result.id }, "revoke")).toEqual({ ok: true });
    expect(test.api("rule.revoke", { id: result.id }, "revoke")).toEqual({ ok: true });
    expect(test.store.snapshot().rule?.[0]?.revokedAt).toBeDefined();
    expect(test.store.snapshot().audit).toHaveLength(2);
    const snapshot = test.store.snapshot();
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(snapshot);
  } finally {
    test.close();
  }
});
it("refuses unconfirmed, destructive, missing scope, expired, and stale page requests", async () => {
  const test = await fixture();
  try {
    expect(() => test.api("rule.create", { rule: draft, confirmed: false }, "a")).toThrow(
      "confirmation_required",
    );
    expect(() =>
      test.api(
        "rule.create",
        {
          rule: { ...draft, matcher: { tool: "execute", command: { prefix: ["rm", "-rf"] } } },
          confirmed: true,
        },
        "b",
      ),
    ).toThrow("destructive_rule_forbidden");
    expect(() =>
      test.api("rule.create", { rule: { ...draft, scope: "project" }, confirmed: true }, "c"),
    ).toThrow("rule_scope_required");
    expect(() =>
      test.api(
        "rule.create",
        { rule: { ...draft, expiresAt: "2026-10-27T12:00:00Z" }, confirmed: true },
        "d",
      ),
    ).toThrow("invalid_rule_expiry");
    expect(test.store.snapshot().rule ?? []).toHaveLength(0);
    test.api("rule.create", { rule: draft, confirmed: true }, "one");
    test.api("rule.create", { rule: draft, confirmed: true }, "two");
    const page = test.api("rule.list", { limit: 1 }) as { cursor: string };
    test.api("rule.create", { rule: draft, confirmed: true }, "three");
    expect(() => test.api("rule.list", { limit: 1, cursor: page.cursor })).toThrow(
      "rule_cursor_stale",
    );
  } finally {
    test.close();
  }
});

it("rejects changed creation payloads on receipt replay and keeps rule pages stable across unrelated writes", async () => {
  const test = await fixture();
  try {
    test.api("rule.create", { rule: draft, confirmed: true }, "create-once");
    expect(() =>
      test.api(
        "rule.create",
        { rule: { ...draft, decision: "deny" }, confirmed: true },
        "create-once",
      ),
    ).toThrow("command_receipt_conflict");
    expect(() => test.api("rule.create", { rule: draft, confirmed: false }, "create-once")).toThrow(
      "command_receipt_conflict",
    );
    test.api("rule.create", { rule: draft, confirmed: true }, "second");
    const page = test.api("rule.list", { limit: 1 }) as { cursor: string };
    const { handle } = await import("@zoltbot/core");
    test.store.dispatch("unrelated", (state) =>
      handle(
        state,
        { type: "create", kind: "settings", value: { key: "theme", value: "dark" } },
        {
          commandId: "unrelated",
          at: "2026-10-28T12:00:00.000Z",
          actor: { kind: "human", id: "owner" },
        },
      ),
    );
    expect(test.api("rule.list", { limit: 1, cursor: page.cursor })).toMatchObject({
      items: [expect.any(Object)],
    });
  } finally {
    test.close();
  }
});

it("previews current saved command rules without writing or running a command", async () => {
  const test = await fixture();
  try {
    const allow = test.api("rule.create", { rule: draft, confirmed: true }, "allow") as {
      id: string;
    };
    const before = test.store.lastSeq();
    expect(test.api("rule.test", { command: "git status --short", tool: "execute" })).toMatchObject(
      { decision: "allow", ruleId: allow.id, reason: "matched" },
    );
    expect(
      test.api("rule.test", { command: "git status; echo unsafe", tool: "execute" }),
    ).toMatchObject({ decision: "ask", destructive: true });
    expect(test.store.lastSeq()).toBe(before);
    test.api("rule.revoke", { id: allow.id }, "revoke");
    expect(test.api("rule.test", { command: "git status --short", tool: "execute" })).toMatchObject(
      { decision: "ask", reason: "no_rule" },
    );
  } finally {
    test.close();
  }
});

it("checks known private values before a rule write and replays a committed receipt without another protected lookup", async () => {
  const test = await fixture();
  const { PrivateInputGuard } = await import("./private-input.js");
  const privacy = new PrivateInputGuard({ store: test.store, publish() {} });
  let checks = 0;
  let unavailable = false;
  const api = ruleApi({
    store: test.store,
    publish() {},
    checkPublic: async (value) => {
      checks++;
      if (unavailable) throw new Error("protected_lookup_unavailable");
      return privacy.prepareData(value);
    },
  });
  try {
    privacy.remember("synthetic-private-rule-value");
    const before = test.store.lastSeq();
    await expect(
      api(
        "rule.create",
        {
          rule: {
            ...draft,
            decision: "deny",
            matcher: {
              tool: "execute",
              command: { prefix: ["echo", "synthetic-private-rule-value"] },
            },
          },
          confirmed: true,
        },
        "private-rule",
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(test.store.lastSeq()).toBe(before);
    expect(test.store.receipt("private-rule")).toBeUndefined();
    const saved = await api("rule.create", { rule: draft, confirmed: true }, "public-rule");
    const readCount = checks;
    unavailable = true;
    expect(await api("rule.create", { rule: draft, confirmed: true }, "public-rule")).toEqual(
      saved,
    );
    expect(checks).toBe(readCount);
  } finally {
    test.close();
  }
});

it("fences concurrent different drafts that share a command id after asynchronous public checks", async () => {
  const test = await fixture();
  const releases: (() => void)[] = [];
  const api = ruleApi({
    store: test.store,
    publish() {},
    checkPublic: async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return () => {};
    },
  });
  try {
    const first = api("rule.create", { rule: draft, confirmed: true }, "shared-command");
    const second = api(
      "rule.create",
      { rule: { ...draft, decision: "deny" }, confirmed: true },
      "shared-command",
    );
    const rejected = expect(second).rejects.toThrow("command_receipt_conflict");
    releases[0]?.();
    await first;
    releases[1]?.();
    await rejected;
    expect(test.store.snapshot().rule).toHaveLength(1);
  } finally {
    test.close();
  }
});

it("checks editable matcher text without treating generated dates and ids as private input", async () => {
  const test = await fixture();
  const { PrivateInputGuard } = await import("./private-input.js");
  const privacy = new PrivateInputGuard({ store: test.store, publish() {} });
  privacy.remember("1");
  const api = ruleApi({
    store: test.store,
    publish() {},
    checkPublic: (value) => privacy.prepareData(value),
  });
  try {
    const saved = await api(
      "rule.create",
      { rule: { ...draft, expiresAt: "2099-01-01T00:00:00.000Z" }, confirmed: true },
      "dated-rule",
    );
    expect(saved).toMatchObject({ expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(await api("rule.list", {})).toMatchObject({ items: [saved] });
  } finally {
    test.close();
  }
});

it("filters rule scope and activity and previews deny precedence", async () => {
  const test = await fixture();
  try {
    const allow = test.api("rule.create", { rule: draft, confirmed: true }, "allow") as {
      id: string;
    };
    const deny = test.api(
      "rule.create",
      { rule: { ...draft, decision: "deny" }, confirmed: true },
      "deny",
    ) as { id: string };
    expect(test.api("rule.test", { command: "git status", tool: "execute" })).toMatchObject({
      decision: "deny",
      ruleId: deny.id,
    });
    expect(test.api("rule.list", { scope: "project" })).toEqual({ items: [] });
    test.api("rule.revoke", { id: deny.id }, "revoke-deny");
    expect(test.api("rule.list", { state: "active", scope: "global" })).toMatchObject({
      items: [{ id: allow.id }],
    });
    expect(test.api("rule.list", { state: "inactive" })).toMatchObject({
      items: [{ id: deny.id }],
    });
  } finally {
    test.close();
  }
});
