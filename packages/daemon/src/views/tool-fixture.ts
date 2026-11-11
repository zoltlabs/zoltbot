import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { RuntimeContext } from "../api-types.js";
import { InteractionEngine } from "../interaction-engine.js";
import { knowledgeWriteFixture } from "../knowledge-write-fixture.js";
import { ViewRegistry } from "./registry.js";
import { respondViewApproval } from "./tool-save.js";
import { viewToolHint, viewTools } from "./tools.js";
export async function viewToolFixture() {
  const k = await knowledgeWriteFixture({ task: false }),
    builtin = path.join(k.f.root, "builtin");
  await mkdir(path.join(builtin, "example"), { recursive: true });
  await writeFile(
    path.join(builtin, "example/view.json"),
    JSON.stringify({
      manifest: 1,
      id: "example",
      name: "Example",
      version: "1.0.0",
      api: 1,
      entry: "index.html",
      slots: ["page"],
      permissions: ["read"],
    }),
  );
  await writeFile(path.join(builtin, "example/index.html"), "<h1>Example</h1>");
  await writeFile(path.join(builtin, "example/style.css"), "body { color: var(--zb-text); }");
  await writeFile(path.join(builtin, "example/vendor.js"), `// ${"unchanged ".repeat(1200)}`);
  k.f.store.dispatch("view-test-permission", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { permissionProfile: "workspace_write" },
        confirmed: true,
      },
      {
        commandId: "view-test-permission",
        at: new Date().toISOString(),
        actor: { kind: "human", id: "local-owner" },
      },
    ),
  );
  k.change({
    type: "create",
    kind: "settings",
    value: {
      key: "runtime.configuration.session",
      value: {
        profile: { permissionProfile: "workspace_write" },
        launchManifest: { hostTools: [viewToolHint] },
      },
    },
  });
  const registry = new ViewRegistry(
    k.f.store,
    builtin,
    path.join(k.f.root, "views"),
    k.context.publish,
    (value) => k.context.privacy.prepareData(value),
  );
  await registry.reload();
  const context: RuntimeContext = { ...k.context, views: registry },
    tools = viewTools(context);
  const engine = new InteractionEngine({
    store: k.f.store,
    publish: k.context.publish,
    preparePublicAnswer: (request, answer) => k.context.privacy.prepareAnswer(request, answer),
    host: {
      registerSecret() {},
      requiresSecretReply: () => false,
      respond: (request, answer) => respondViewApproval(context, request, answer),
    },
  });
  return {
    ...k,
    context,
    tools,
    registry,
    engine,
    async stage(files: Record<string, string>) {
      const dir = `.zoltbot/staging/${randomUUID()}`;
      for (const [name, text] of Object.entries(files)) {
        const target = path.join(k.f.root, dir, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, text);
      }
      return dir;
    },
    call(args: Record<string, unknown>, key: string = randomUUID()) {
      return tools.call({ actor: k.actor, arguments: args, idempotencyKey: key });
    },
    async close() {
      await registry.close();
      k.f.close();
    },
  };
}
