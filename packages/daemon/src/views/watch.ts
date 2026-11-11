import { watch } from "node:fs";
/** One native watch for the user tree. Builtin files and saved state are outside it. */
export function watchViews(
  directory: string,
  reload: () => Promise<unknown>,
  failed: () => void = () => {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  const watcher = watch(directory, { recursive: true, encoding: "utf8" }, (_event, filename) => {
    if (closed || filename?.startsWith(".view-stage-") || filename?.startsWith(".view-rename-"))
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) void reload().catch(failed);
    }, 300);
  });
  watcher.on("error", failed);
  return () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    watcher.close();
  };
}
