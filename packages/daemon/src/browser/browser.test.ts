import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { parseEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { Redactor } from "../logging.js";
import { evidenceBytes, registerEvidence, validatePng } from "./evidence.js";
import { browserObserver } from "./observation.js";
import {
  browserBinding,
  browserCommand,
  browserEnvironment,
  materializeBrowser,
  redactBrowserText,
  validateBrowserArgs,
} from "./runtime.js";

// A real RGB PNG, no private page content.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
async function fixture() {
  const f = await runtimeFixture();
  let n = 0;
  const change = (command: Parameters<typeof handle>[1]) => {
    const commandId = `browser-seed-${++n}`;
    f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "test" } }),
    );
  };
  const binding = browserBinding(f.root, f.root, {
    mode: "background",
    url: "http://127.0.0.1:3456",
  });
  materializeBrowser(binding);
  change({
    type: "create",
    kind: "task",
    value: {
      id: "task",
      rootId: "task",
      title: "Browser",
      brief: "Check fixture",
      acceptance: "",
      expectedDeliverable: "",
      ownerAgentId: "profile",
      threadId: "thread",
      workspaceMode: "shared",
      state: "queued",
      revision: 1,
      attempt: 1,
      maxAttempts: 1,
      reviewRequired: true,
      executionLocation: "local_host",
      createdBy: { kind: "human", id: "test" },
      createdAt: at,
      updatedAt: at,
    },
  });
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { kind: "task", taskId: "task" },
  });
  change({
    type: "create",
    kind: "settings",
    value: {
      key: "runtime.configuration.session",
      value: { launchManifest: { executionId: "execution", browser: binding } },
    },
  });
  writeFileSync(path.join(binding.artifactRoot, "capture.png"), png);
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session" };
  const args = {
    path: "capture.png",
    url: "http://127.0.0.1:3456/check?token=fixture-sentinel#fragment",
    viewport: { width: 1, height: 1 },
    check: "Fixture check",
    outcome: "passed" as const,
  };
  return { ...f, binding, change, actor, args };
}
it("pins launcher routing, strips ambient overrides, blocks sibling/global/profile arguments, and redacts URL sentinels", async () => {
  const f = await runtimeFixture();
  try {
    const a = browserBinding(f.root, f.root, { mode: "background" }),
      b = browserBinding(f.root, f.root, { mode: "background" });
    expect(a.session).not.toBe(b.session);
    expect(a.artifactRoot).not.toBe(b.artifactRoot);
    for (const args of [
      ["close-all"],
      ["kill-all"],
      ["attach", "chrome"],
      ["open", "--session=sibling"],
      ["open", "-ssibling"],
      ["--json", "close-all"],
      ["open", "--no-config"],
      ["open", "--profile", "personal"],
      ["state-load", "account.json"],
      ["open", "--cdp=http://localhost"],
    ])
      expect(() => validateBrowserArgs(args)).toThrow();
    process.env.PLAYWRIGHT_CLI_SESSION = "hostile";
    expect(browserEnvironment(a).PLAYWRIGHT_CLI_SESSION).toBeUndefined();
    delete process.env.PLAYWRIGHT_CLI_SESSION;
    materializeBrowser(a);
    const source = readFileSync(`${a.launcher}.mjs`, "utf8");
    expect(source).toContain(`-s=${a.session}`);
    expect(source).not.toContain("hostile");
    expect(await browserCommand(a, ["--version"])).toContain("0.1.23");
    expect(
      redactBrowserText("failed http://user:pass@localhost:3000/?token=fixture-sentinel#private"),
    ).not.toMatch(/pass|fixture-sentinel|private/);
    chmodSync(a.launcher, 0o600);
    writeFileSync(a.launcher, "changed");
    expect(() => materializeBrowser(a)).toThrow("browser_materialization_changed");
  } finally {
    f.close();
  }
});
it("imports only valid owned PNGs, preserves immutable hashes and revisions, and correlates successful image results only", async () => {
  const f = await fixture();
  try {
    expect(validatePng(png)).toEqual({ width: 1, height: 1 });
    const evidence = registerEvidence(f.store, f.actor, f.args);
    expect(evidence.url).not.toContain("fixture-sentinel");
    expect(evidence.inspection).toBe("not_reported");
    expect(evidenceBytes(f.store, evidence.id)).toEqual(png);
    expect(registerEvidence(f.store, f.actor, f.args).id).toBe(evidence.id);
    expect(() => registerEvidence(f.store, { ...f.actor, sessionId: "other" }, f.args)).toThrow();
    expect(() => registerEvidence(f.store, { ...f.actor, agentId: "other" }, f.args)).toThrow();
    for (const file of ["../capture.png", "/etc/passwd", "evidence/../capture.png"])
      expect(() => registerEvidence(f.store, f.actor, { ...f.args, path: file })).toThrow();
    symlinkSync(
      path.join(f.binding.artifactRoot, "capture.png"),
      path.join(f.binding.artifactRoot, "link.png"),
    );
    expect(() => registerEvidence(f.store, f.actor, { ...f.args, path: "link.png" })).toThrow(
      "evidence_symlink_denied",
    );
    writeFileSync(path.join(f.binding.artifactRoot, "deceptive.png"), "<svg></svg>");
    expect(() =>
      registerEvidence(f.store, f.actor, { ...f.args, path: "deceptive.png" }),
    ).toThrow();
    const observer = browserObserver(f.store, "execution", "session");
    observer({
      t: "tool.started",
      turnId: "turn",
      itemId: "read",
      name: "Read",
      kind: "read",
      input: { file_path: evidence.canonicalPath },
    });
    expect(f.store.database.prepare("SELECT * FROM browser_observations").all()).toHaveLength(0);
    observer({
      t: "tool.done",
      itemId: "read",
      status: "ok",
      output: [{ type: "text", text: "image path only" }],
    });
    expect(f.store.database.prepare("SELECT * FROM browser_observations").all()).toHaveLength(0);
    observer({
      t: "tool.started",
      turnId: "turn",
      itemId: "read2",
      name: "Read",
      kind: "read",
      input: { file_path: evidence.canonicalPath },
    });
    observer({
      t: "tool.done",
      itemId: "read2",
      status: "ok",
      output: [{ type: "image", source: { data: "omitted-for-test" } }],
    });
    expect(f.store.database.prepare("SELECT * FROM browser_observations").all()).toHaveLength(1);
    expect(JSON.stringify(f.store.snapshot())).not.toContain(png.toString("base64"));
    f.store.dispatch("revision-two", (state) => ({
      events: [
        parseEvent({
          eventId: "revision-two",
          commandId: "revision-two",
          aggregateType: "task",
          aggregateId: "task",
          type: "task.updated",
          occurredAt: at,
          payload: { ...state.task?.[0], revision: 2 },
        }),
      ],
      result: null,
    }));
    expect(registerEvidence(f.store, f.actor, f.args).id).not.toBe(evidence.id);
    chmodSync(evidence.canonicalPath, 0o600);
    writeFileSync(evidence.canonicalPath, Buffer.concat([png, Buffer.from("corrupt")]));
    expect(() => evidenceBytes(f.store, evidence.id)).toThrow();
    rmSync(evidence.canonicalPath);
    expect(() => evidenceBytes(f.store, evidence.id)).toThrow();
  } finally {
    f.close();
  }
});
it("rejects truncated, corrupt, oversized and deceptive PNG payloads", () => {
  expect(() => validatePng(png.subarray(0, 40))).toThrow();
  const corrupt = Buffer.from(png);
  corrupt[42] = (corrupt[42] ?? 0) ^ 1;
  expect(() => validatePng(corrupt)).toThrow();
  expect(() => validatePng(Buffer.alloc(8 * 1024 * 1024 + 1))).toThrow();
});

it("serves only authenticated bounded hash-validated image bytes, with no file path route", async () => {
  const f = await fixture();
  const { startDaemon } = await import("../api.js");
  const daemon = await startDaemon({ dataDir: path.join(f.root, "daemon") });
  try {
    daemon.store.dispatch("copy-fixture", () => ({ events: f.store.eventsSince(0), result: null }));
    const e = registerEvidence(daemon.store, f.actor, f.args);
    const url = `${daemon.url.replace("ws:", "http:")}/browser-evidence/${e.id}`;
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(403);
    expect(
      (
        await fetch(url, {
          headers: { Authorization: `Bearer ${daemon.token}`, Origin: "https://untrusted.invalid" },
        })
      ).status,
    ).toBe(403);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect(
      (
        await fetch(`${daemon.url.replace("ws:", "http:")}/browser-evidence/../../etc/passwd`, {
          headers: { Authorization: `Bearer ${daemon.token}` },
        })
      ).status,
    ).toBe(403);
    chmodSync(e.canonicalPath, 0o600);
    writeFileSync(e.canonicalPath, "not png");
    expect(
      (await fetch(url, { headers: { Authorization: `Bearer ${daemon.token}` } })).status,
    ).toBe(404);
  } finally {
    await daemon.close();
    f.close();
  }
});

it("redacts browser URL sentinels and image blobs before native frames or runtime events are persisted", () => {
  const redactor = new Redactor(["KNOWN_PRIVATE_SENTINEL"]);
  redactor.hideBrowserUrls();
  const logged = JSON.stringify(
    redactor.value({
      command: "open https://example.invalid/path?token=QUERY_SENTINEL#FRAGMENT_SENTINEL",
      content: [{ type: "image", source: { type: "base64", data: "IMAGE_BLOB_SENTINEL" } }],
      error: "KNOWN_PRIVATE_SENTINEL",
    }),
  );
  expect(logged).not.toMatch(
    /QUERY_SENTINEL|FRAGMENT_SENTINEL|IMAGE_BLOB_SENTINEL|KNOWN_PRIVATE_SENTINEL/,
  );
});

it("quotes launcher paths without relying on developer Node and rejects symlink output ancestors before writing outside the task", async () => {
  const f = await runtimeFixture();
  try {
    const special = path.join(f.root, "space ' dollar$(no-execute)");
    mkdirSync(special);
    const binding = browserBinding(special, special, { mode: "background" });
    materializeBrowser(binding);
    expect(
      execFileSync(binding.launcher, ["--version"], {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      }),
    ).toContain("0.1.23");
    const cwd = path.join(f.root, "task");
    const outside = path.join(f.root, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    symlinkSync(outside, path.join(cwd, "output"));
    expect(() => materializeBrowser(browserBinding(f.root, cwd, { mode: "background" }))).toThrow(
      "browser_directory_not_owned",
    );
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    f.close();
  }
});
