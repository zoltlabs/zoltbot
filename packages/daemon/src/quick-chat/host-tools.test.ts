import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Snapshot } from "@zoltbot/store";
import { afterEach, expect, it } from "vitest";
import { quickHostTools } from "./host-tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(name: string, files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "quick-tools-"));
  dirs.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return {
    id: name.toLowerCase(),
    name,
    goal: `${name} goal`,
    archived: false,
    roots: [{ path: root, label: name }],
  };
}
const call = (tools: ReturnType<typeof quickHostTools>, name: string, args: unknown) =>
  tools.get(name)?.({
    actor: { agentId: "quick-chat", threadId: "t", sessionId: "s" },
    arguments: args,
    idempotencyKey: "k",
  });

it("lists, searches and reads every workspace without credential files or secrets", async () => {
  const state = {
    project: [
      workspace("Shop", {
        "docs/billing.md": "# Billing\nInvoices go out monthly.\n",
        ".env": "BILLING_TOKEN=abc\n",
        "src/keys.ts": "const billing = 'sk-live-123';\n",
      }),
      workspace("Blog", { "posts/launch.md": `${"line\n".repeat(900)}billing launch\n` }),
      { ...workspace("Old", { "billing.txt": "billing" }), archived: true },
    ],
  } as unknown as Snapshot;
  const tools = quickHostTools({
    state: () => state,
    containsSecret: async (text) => text.includes("sk-live-"),
  });
  expect(await call(tools, "quick_workspaces", {})).toEqual({
    workspaces: [
      { id: "shop", name: "Shop", goal: "Shop goal", folders: ["Shop"] },
      { id: "blog", name: "Blog", goal: "Blog goal", folders: ["Blog"] },
    ],
  });
  const found = (await call(tools, "quick_search", { query: "billing" })) as {
    matches: { workspace: string; path: string; line?: number }[];
  };
  expect(
    found.matches.map((row) => `${row.workspace}:${row.path}:${row.line ?? ""}`).sort(),
  ).toEqual(["Blog:posts/launch.md:901", "Shop:docs/billing.md:"]);
  expect(await call(tools, "quick_search", { query: "invoices", workspace: "shop" })).toEqual({
    matches: [
      { workspace: "Shop", path: "docs/billing.md", line: 2, text: "Invoices go out monthly." },
    ],
  });
  const first = (await call(tools, "quick_read", {
    workspace: "Blog",
    path: "posts/launch.md",
  })) as {
    text: string;
    next?: number;
  };
  expect(first.text.length).toBeLessThanOrEqual(3000);
  expect(first.next).toBeGreaterThan(1);
  expect(
    await call(tools, "quick_read", { workspace: "Blog", path: "posts/launch.md", line: 901 }),
  ).toMatchObject({ text: "billing launch\n\n" });
  await expect(call(tools, "quick_read", { workspace: "Shop", path: ".env" })).rejects.toThrow(
    "quick_file_private",
  );
  await expect(
    call(tools, "quick_read", { workspace: "Shop", path: "src/keys.ts" }),
  ).rejects.toThrow("quick_file_private");
  await expect(
    call(tools, "quick_read", { workspace: "Shop", path: "../../etc/hosts" }),
  ).rejects.toThrow();
  await expect(
    call(tools, "quick_read", { workspace: "Old", path: "billing.txt" }),
  ).rejects.toThrow("quick_workspace_unavailable");
});
