import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { at, draft, fixture, human } from "./interaction-test-fixture.js";

it("rechecks path evidence inside the rule transaction before sending an automatic answer", async () => {
  const test = await fixture();
  let checks = 0;
  test.host.approvalPaths = () => (++checks === 1 ? ["src/a.ts"] : undefined);
  try {
    test.store.dispatch("path-rule", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "rule",
          confirmed: true,
          value: {
            id: "path-rule",
            scope: "global",
            matcher: { tool: "Write", kind: "edit", paths: ["src/**"] },
            decision: "allow",
            createdBy: human,
            createdAt: at,
          },
        },
        { commandId: "path-rule", at, actor: human },
      ),
    );
    test.engine.request(
      {
        ...draft,
        id: "edit-request",
        type: "approval",
        context: { toolName: "Write", toolKind: "edit", paths: ["/workspace/src/a.ts"] },
        items: [
          {
            id: "edit",
            prompt: "Allow edit?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
      },
      "edit-request",
    );
    await expect.poll(() => checks).toBe(2);
    expect(test.replies).toHaveLength(0);
    expect(test.store.snapshot().interaction?.find((row) => row.id === "edit-request")?.state).toBe(
      "pending",
    );
  } finally {
    await test.engine.stopTimers();
    test.close();
  }
});

it("automatically answers a path rule only with current verified evidence and records its rule audit", async () => {
  const test = await fixture();
  test.host.approvalPaths = () => ["src/a.ts"];
  try {
    test.store.dispatch("verified-path-rule", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "rule",
          confirmed: true,
          value: {
            id: "verified-path-rule",
            scope: "global",
            matcher: { tool: "Write", kind: "edit", paths: ["src/**"] },
            decision: "allow",
            createdBy: human,
            createdAt: at,
          },
        },
        { commandId: "verified-path-rule", at, actor: human },
      ),
    );
    test.engine.request(
      {
        ...draft,
        id: "verified-edit",
        type: "approval",
        context: { toolName: "Write", toolKind: "edit", paths: ["/workspace/src/a.ts"] },
        items: [
          {
            id: "edit",
            prompt: "Allow edit?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
      },
      "verified-edit",
    );
    await expect.poll(() => test.replies.length).toBe(1);
    expect(test.replies[0]).toMatchObject({
      action: "accept",
      choice: "allow_once",
      automatic: true,
    });
    expect(
      test.store.snapshot().interaction?.find((row) => row.id === "verified-edit"),
    ).toMatchObject({ state: "answered", version: 2 });
    expect(
      test.store
        .snapshot()
        .audit?.some(
          (row) =>
            row.action === "interaction.answer" &&
            (row.detail as Record<string, unknown>).ruleId === "verified-path-rule",
        ),
    ).toBe(true);
  } finally {
    await test.engine.stopTimers();
    test.close();
  }
});
