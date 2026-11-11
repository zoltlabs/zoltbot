import path from "node:path";
export function viewFolderPath(root: string, dataDir: string, input: unknown) {
  if (!input || typeof input !== "object") throw Error("invalid_view_folder");
  const value = input as { id?: unknown; source?: unknown };
  if (
    typeof value.id !== "string" ||
    !/^[a-z0-9-]{2,40}$/.test(value.id) ||
    !["builtin", "user"].includes(String(value.source))
  )
    throw Error("invalid_view_folder");
  return path.resolve(
    value.source === "builtin" ? path.join(root, "packages/views") : path.join(dataDir, "views"),
    value.id,
  );
}
