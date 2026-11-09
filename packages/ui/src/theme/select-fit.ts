/**
 * A customizable select (select.css) sizes itself to the chosen option, so a select that its CSS
 * leaves at `width: auto` would jump as people pick. Hold each such select at its widest option's
 * width, the way native selects size; selects with a width from CSS keep it.
 */
export function holdSelectWidths(root: HTMLElement): () => void {
  if (!CSS.supports("appearance", "base-select")) return () => {};
  // The option labels each select was last fitted to, and the selects whose inline width is ours.
  const fitted = new WeakMap<HTMLSelectElement, string>();
  const held = new WeakSet<HTMLSelectElement>();
  // A select measured while hidden has no width yet; fit it once it lays out.
  const shown = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (!entry.contentRect.width) continue;
      shown.unobserve(entry.target);
      fit(entry.target as HTMLSelectElement, true);
    }
  });
  const fit = (select: HTMLSelectElement, again = false) => {
    if (select.multiple || select.size > 1 || !select.options.length) return;
    const labels = [...select.options].map((option) => option.label).join("\n");
    if (!again && fitted.get(select) === labels) return;
    fitted.set(select, labels);
    if (held.delete(select)) select.style.width = "";
    if (select.computedStyleMap().get("width")?.toString() !== "auto") return;
    if (!select.getClientRects().length) {
      shown.observe(select);
      return;
    }
    const chosen = select.selectedIndex;
    let widest = 0;
    for (let index = 0; index < select.options.length; index++) {
      select.selectedIndex = index;
      widest = Math.max(widest, select.getBoundingClientRect().width);
    }
    select.selectedIndex = chosen;
    select.style.width = `${Math.ceil(widest)}px`;
    held.add(select);
  };
  const fitWithin = (node: Node) => {
    if (node instanceof HTMLSelectElement) fit(node);
    else if (node instanceof Element)
      for (const select of node.querySelectorAll("select")) fit(select);
  };
  // Mutation callbacks run before the next paint, so a new or relabelled select never shows unfitted.
  const changes = new MutationObserver((records) => {
    for (const record of records) {
      const owner =
        record.target instanceof Element
          ? record.target.closest("select")
          : record.target.parentElement?.closest("select");
      if (owner) fit(owner);
      for (const node of record.addedNodes) fitWithin(node);
    }
  });
  changes.observe(root, { childList: true, subtree: true, characterData: true });
  fitWithin(root);
  // Labels measured in the fallback font are narrower than in the app font.
  const refit = () => {
    for (const select of root.querySelectorAll("select")) fit(select, true);
  };
  document.fonts.addEventListener("loadingdone", refit);
  return () => {
    changes.disconnect();
    shown.disconnect();
    document.fonts.removeEventListener("loadingdone", refit);
  };
}
