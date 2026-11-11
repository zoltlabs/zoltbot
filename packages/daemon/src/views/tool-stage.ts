import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { artifactLimits, possibleSecret } from "@zoltbot/artifact-validation";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api-types.js";
import { safeFile } from "../artifacts/intake.js";
import { stagedFiles } from "../artifacts/staging.js";
import { exists, userRoot } from "./files.js";
import { checkedViewPath, loadView } from "./loader.js";
import { viewActor } from "./tool-owner.js";
import type { ViewToolArgs } from "./tool-read.js";
export async function stageView(context: RuntimeContext, call: ToolInvocation, args: ViewToolArgs) {
  const { registry, session } = viewActor(context, call.actor, true);
  if (typeof args.id !== "string") throw Error("invalid_view_save");
  const id = args.id;
  if (!/^[a-z0-9-]{2,40}$/.test(id) || !args.source?.dir || !args.key)
    throw Error("invalid_view_save");
  const match =
    /^\.zoltbot\/staging\/([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})(?:\/[a-z0-9-]{2,40})?$/.exec(
      args.source.dir,
    );
  if (!match?.[1]) throw Error("view_staging_scope_denied");
  const current = context.store.record("view", id);
  if (current?.removed) throw Error("view_id_retired");
  const base = current ? registry.bundle(String(current.bundleHash)) : undefined;
  if (current && (!base || args.baseHash !== base.bundleHash)) throw Error("view_changed");
  if (!current && args.baseHash !== undefined) throw Error("view_changed");
  if (current?.source === "builtin" && (await exists(path.join(registry.user, id))))
    throw Error("view_broken_override");
  await userRoot(registry.user);
  const proposalId = randomUUID(),
    root = path.join(registry.user, `.view-stage-${proposalId}`),
    folder = path.join(root, id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const texts: unknown[] = [],
    sizes = new Map<string, number>();
  let total = 0;
  async function put(name: string, bytes: Buffer) {
    total += bytes.length - (sizes.get(name) ?? 0);
    sizes.set(name, bytes.length);
    if (total > artifactLimits.version || sizes.size > artifactLimits.files)
      throw Error("view_total_limit");
    const destination = path.join(folder, name);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { mode: 0o600 });
  }
  try {
    if (base)
      for (const file of base.files)
        await put(file.path, (await registry.asset(base.bundleHash, file.hash)).bytes);
    const seen = new Set<string>();
    for await (const file of stagedFiles(
      { stagingRoot: path.join(String(session.cwd), ".zoltbot/staging", match[1]) },
      args.source.dir,
    )) {
      const name = checkedViewPath(file.path, seen);
      if (
        base?.files.some(
          (old) => old.path.toLowerCase() === name.toLowerCase() && old.path !== name,
        )
      )
        throw Error("view_path_collision");
      await put(name, file.bytes);
    }
    if (current?.source === "builtin" && base) {
      const manifest = JSON.parse((await safeFile(folder, "view.json")).toString("utf8"));
      manifest.basedOn = {
        id: base.manifest.id,
        version: base.manifest.version,
        bundleHash: base.bundleHash,
      };
      await put("view.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    }
    const checked = await loadView(folder);
    for (const file of checked.files)
      if (/^(text\/|application\/json$|image\/svg\+xml$)/.test(file.mime)) {
        const bytes = await safeFile(folder, file.path);
        const text = bytes.toString("utf8");
        if (possibleSecret(file.path, text)) throw Error("view_private_source");
        texts.push(text);
      }
    const guard = await context.privacy.prepareData(texts);
    guard(context.store.snapshot());
    const changed = checked.files
      .filter((file) => base?.files.find((old) => old.path === file.path)?.hash !== file.hash)
      .map((file) => file.path);
    return { proposalId, root, folder, checked, base, changed, guard };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
