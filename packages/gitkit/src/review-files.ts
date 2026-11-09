import { git } from "./git.js";

export interface ReviewFile {
  path: string;
  previousPath?: string;
  added: number;
  removed: number;
  binary: boolean;
  patch: string;
  unavailable?: string;
}
/** NUL-delimited Git metadata keeps tabs, newlines and quoted names intact. */
export async function reviewFiles(cwd: string, base: string): Promise<ReviewFile[]> {
  const fields = (
    await git(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "-z",
      "--find-renames",
      base,
      "--",
    ])
  ).split("\0");
  const files: ReviewFile[] = [];
  let budget = 1024 * 1024;
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i] ?? "");
    if (!match) continue;
    const previousPath = match[3] === "" ? fields[++i] : undefined;
    const path = previousPath === undefined ? match[3] : fields[++i];
    if (!path) continue;
    const file: ReviewFile = {
      path,
      ...(previousPath ? { previousPath } : {}),
      added: Number(match[1]) || 0,
      removed: Number(match[2]) || 0,
      binary: match[1] === "-",
      patch: "",
    };
    if (file.binary) file.unavailable = "Binary content is not displayed.";
    else if (files.length >= 200 || file.added + file.removed > 12000 || budget <= 0)
      file.unavailable = "Large diff omitted. Inspect this file in your local editor.";
    else {
      try {
        const patch = await git(cwd, [
          "--literal-pathspecs",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          base,
          "--",
          ...(previousPath ? [previousPath] : []),
          path,
        ]);
        if (patch.length > Math.min(budget, 256 * 1024))
          file.unavailable = "Large diff omitted. Inspect this file in your local editor.";
        else {
          file.patch = patch;
          budget -= patch.length;
        }
      } catch {
        file.unavailable = "Diff could not be loaded. Refresh or inspect locally.";
      }
    }
    files.push(file);
  }
  return files;
}
