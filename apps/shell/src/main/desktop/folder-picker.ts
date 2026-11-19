import { realpath, stat } from "node:fs/promises";
import path from "node:path";

type Selection = { canceled: boolean; filePaths: string[] };
/** The native dialog supplies paths. Renderer callers cannot supply a directory to inspect. */
export function folderPicker(choose: () => Promise<Selection>) {
  let pending: Promise<string[]> | undefined;
  return (): Promise<string[]> => {
    if (pending) return pending.then((paths) => [...paths]);
    pending = (async () => {
      let selection: Selection;
      try {
        selection = await choose();
      } catch {
        throw new Error("folder_picker_failed");
      }
      if (selection.canceled) return [];
      if (selection.filePaths.length > 100) throw new Error("invalid_folder_selection");
      const paths: string[] = [];
      for (const value of selection.filePaths) {
        if (!path.isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value))
          throw new Error("invalid_folder_selection");
        try {
          const canonical = await realpath(value);
          if (
            canonical.length > 4096 ||
            /[\0\r\n]/.test(canonical) ||
            !(await stat(canonical)).isDirectory()
          )
            throw new Error("invalid_folder_selection");
          paths.push(canonical);
        } catch {
          throw new Error("invalid_folder_selection");
        }
      }
      return [...new Set(paths)];
    })().finally(() => {
      pending = undefined;
    });
    return pending.then((paths) => [...paths]);
  };
}
