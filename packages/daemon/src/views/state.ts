import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { possibleSecret } from "@zoltbot/artifact-validation";
import { checkedAncestors, safeFile } from "../artifacts/intake.js";
import { requireViewGrant } from "./actions.js";
import type { ViewRegistry } from "./registry.js";
export const viewStateLimit = 256 * 1024;
export const stateDirectory = (registry: ViewRegistry) =>
  path.join(path.dirname(registry.user), "view-state");
function checkId(id: string) {
  if (!/^[a-z0-9-]{2,40}$/.test(id)) throw Error("invalid_view_id");
}
export async function readViewState(registry: ViewRegistry, id: string) {
  checkId(id);
  try {
    const bytes = await safeFile(stateDirectory(registry), `${id}.json`);
    if (bytes.length > viewStateLimit) throw Error("view_state_too_large");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function writeViewState(
  registry: ViewRegistry,
  id: string,
  value: unknown,
  check: () => void = () => {},
) {
  checkId(id);
  const json = JSON.stringify(value);
  if (json === undefined) throw Error("invalid_view_state");
  const bytes = Buffer.from(json);
  if (bytes.length > viewStateLimit) throw Error("view_state_too_large");
  if (possibleSecret("", json)) throw Error("view_private_state");
  const guard = await registry.checkPublic(value);
  check();
  guard(registry.store.snapshot());
  const directory = stateDirectory(registry);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ancestors = await checkedAncestors(directory);
  const info = await lstat(directory);
  if (info.uid !== process.getuid?.()) throw Error("view_state_directory_denied");
  // Reject an existing symlink or hardlink even though rename would not follow it.
  await readViewState(registry, id);
  const temporary = path.join(directory, `.${randomUUID()}.partial`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    check();
    guard(registry.store.snapshot());
    if ((await checkedAncestors(directory)) !== ancestors)
      throw Error("view_state_directory_changed");
    await rename(temporary, path.join(directory, `${id}.json`));
    if ((await checkedAncestors(directory)) !== ancestors)
      throw Error("view_state_directory_changed");
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function viewStateApi(
  registry: ViewRegistry,
  method: string,
  params: Record<string, unknown>,
) {
  const id = String(params.id),
    check = () => requireViewGrant(registry, id, "read");
  check();
  if (method === "view.state.get") {
    const value = await readViewState(registry, id);
    check();
    return { value };
  }
  await writeViewState(registry, id, params.value, check);
  return { ok: true };
}
