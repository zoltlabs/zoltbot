import { possibleSecret } from "@zoltbot/artifact-validation";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "../api-types.js";
import { sourceTextPage } from "../artifacts/read-source.js";
import { viewOrigin } from "./origin.js";
import { viewActor } from "./tool-owner.js";
export interface ViewToolArgs {
  action: string;
  id?: string;
  path?: string;
  cursor?: string;
  bundleHash?: string;
  baseHash?: string;
  source?: { dir: string };
  key?: string;
}
export async function readViewTool(context: RuntimeContext, call: ToolInvocation) {
  const { registry } = viewActor(context, call.actor),
    args = call.arguments as ViewToolArgs;
  if (args.action === "list") {
    const records = (context.store.snapshot(["view"]).view ?? [])
      .filter((record) => !record.removed)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const items: Record<string, unknown>[] = [];
    for (const record of records.filter(
      (record) => !args.cursor || String(record.id) > args.cursor,
    )) {
      const item = {
        id: record.id,
        name: record.name,
        source: record.source,
        bundleHash: record.bundleHash,
        createdHere:
          record.source === "user" &&
          viewOrigin(context.store, String(record.id)) === call.actor.threadId,
      };
      if (JSON.stringify([...items, item]).length > 2600) break;
      items.push(item);
    }
    const check = await context.privacy.prepareData(items);
    check(context.store.snapshot());
    return {
      items,
      cursor:
        items.length && records.some((row) => String(row.id) > String(items.at(-1)?.id))
          ? items.at(-1)?.id
          : null,
      usage:
        "read: id, bundleHash, path, cursor. save: id, baseHash, source.dir, key. Stage changed files under .zoltbot/staging/<uuid>; existing views need owner consent. Grants never change.",
    };
  }
  if (typeof args.id !== "string") throw Error("invalid_view_read");
  const record = context.store.record("view", args.id),
    bundle = record && !record.removed ? registry.bundle(String(record.bundleHash)) : undefined;
  if (!record || !bundle) throw Error("view_not_found");
  if (args.path === undefined) {
    if (args.cursor && !bundle.files.some((file) => file.path === args.cursor))
      throw Error("view_cursor_invalid");
    const files: typeof bundle.files = [];
    for (const file of bundle.files.filter((file) => !args.cursor || file.path > args.cursor)) {
      if (JSON.stringify([...files, file]).length > 2200) break;
      files.push(file);
    }
    const value = {
      id: args.id,
      bundleHash: bundle.bundleHash,
      files,
      cursor:
        files.length && bundle.files.some((file) => file.path > String(files.at(-1)?.path))
          ? files.at(-1)?.path
          : null,
    };
    const check = await context.privacy.prepareData(value);
    check(context.store.snapshot());
    return value;
  }
  if (args.bundleHash !== bundle.bundleHash) throw Error("view_changed");
  const file = bundle.files.find((file) => file.path === args.path);
  if (!file) throw Error("view_file_not_found");
  if (!/^(text\/|application\/json$|image\/svg\+xml$)/.test(file.mime))
    return { id: args.id, path: args.path, editable: false, reason: "binary_asset" };
  const { bytes } = await registry.asset(bundle.bundleHash, file.hash),
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (possibleSecret(file.path, text)) return { id: args.id, path: args.path, held: true };
  const check = await context.privacy.prepareData({ path: args.path, text });
  check(context.store.snapshot());
  return sourceTextPage(text, `${bundle.bundleHash}:${file.hash}:`, args.cursor, {
    id: args.id,
    bundleHash: bundle.bundleHash,
    path: args.path,
    editable: true,
    untrusted: true,
  });
}
