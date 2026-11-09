export const usableShellMark = "zoltbot.usable-shell";

/** First visible frame with an authenticated snapshot rendered in the shell. No user data. */
export function trackUsableShell(root: HTMLElement): () => void {
  if (performance.getEntriesByName(usableShellMark, "mark").length) return () => {};
  let frame: number | undefined;
  const observer = new MutationObserver(schedule);
  const stop = () => {
    observer.disconnect();
    document.removeEventListener("visibilitychange", schedule);
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  function schedule() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const status = root.querySelector<HTMLElement>('[data-connection-status="online"]');
      if (!status || document.visibilityState !== "visible") return;
      const bounds = status.getBoundingClientRect();
      if (!bounds.width || !bounds.height || getComputedStyle(status).visibility !== "visible")
        return;
      performance.mark(usableShellMark);
      stop();
    });
  }
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-connection-status"],
  });
  document.addEventListener("visibilitychange", schedule);
  schedule();
  return stop;
}
