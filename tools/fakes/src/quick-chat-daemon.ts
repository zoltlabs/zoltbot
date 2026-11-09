import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "@zoltbot/daemon";
import type { EntityKind } from "@zoltbot/protocol";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { startFakeProviders } from "./quick-chat-providers.js";
import { fakeToolDefinitions, fakeToolRuntime } from "./quick-chat-tools.js";

// Quick Chat browser fixture: a real daemon whose coding tools and inference connections are
// deterministic fakes. Nothing here starts a real tool, reaches a provider, or spends money.
const dataDir = process.env.ZOLTBOT_DATA_DIR;
if (!dataDir) throw new Error("fixture_data_dir_required");
mkdirSync(dataDir, { recursive: true });
const fake = await startFakeProviders();
const keychain = new Map<string, string>();
const daemon = await startDaemon({
  dataDir,
  secrets: new KeychainSecrets(async (request) => {
    if (request.op === "put" || request.op === "replace")
      keychain.set(request.account, request.value ?? "");
    if (request.op === "remove") keychain.delete(request.account);
    return { ok: true, value: keychain.get(request.account), found: keychain.has(request.account) };
  }),
  quickChat: {
    endpoints: { openai: `${fake.url}/v1`, anthropic: fake.url },
    tools: fakeToolRuntime().runtime,
    servers: () => [{ name: "search", tools: ["claude", "codex"] }],
    hostName: "Fixture Mac",
  },
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
});
const folder = path.join(dataDir, "repo");
mkdirSync(path.join(folder, "docs"), { recursive: true });
writeFileSync(
  path.join(folder, "docs/billing.md"),
  "# Billing\nInvoices are sent monthly by the billing worker.\n",
);
writeFileSync(path.join(folder, ".env"), "TOKEN=fixture\n");
const at = "2026-11-06T12:00:00.000Z";
const rows: [EntityKind, Record<string, unknown>][] = [
  ...fakeToolDefinitions.map((value): [EntityKind, Record<string, unknown>] => [
    "agentDefinition",
    value,
  ]),
  [
    "agentDefinition",
    {
      id: "reference",
      displayName: "Reference coding tool",
      adapter: "reference",
      binaryNames: [],
      versionCommand: [],
      launch: { command: "fake", args: [], env: {} },
      testedVersions: "fixture",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    },
  ],
  [
    "agent",
    {
      id: "p",
      definitionId: "reference",
      name: "Builder",
      avatar: "B",
      kind: "profile",
      permissionProfile: "read_only",
      instructions: "",
      hidden: false,
      archived: false,
    },
  ],
  [
    "project",
    {
      id: "proj",
      name: "Zolt",
      goal: "Ship billing",
      instructions: "",
      constraints: "",
      roots: [{ path: folder, label: "repo" }],
      hierarchyDepth: 0,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    },
  ],
];
for (const [kind, value] of rows)
  if (!daemon.store.snapshot()[kind]?.some((row) => row.id === value.id))
    daemon.dispatch({ type: "create", kind, value }, `fixture:${kind}:${value.id}`);
writeFileSync(path.join(dataDir, "providers.json"), JSON.stringify({ url: fake.url }));
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void daemon
      .close()
      .then(() => fake.close())
      .then(() => {
        process.exitCode = 0;
      });
  });
