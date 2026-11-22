// SVG drawn on the phone: scripts, event handlers and anything pointing outside the file are
// removed first, so showing a drawing never fetches from the internet.

const BLOCKS =
  /<(script|foreignObject|iframe)\b[\s\S]*?<\/\1\s*>|<(script|foreignObject|iframe)\b[^>]*\/>/gi;
const HANDLERS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// href and xlink:href may point inside the file (#id) or at an embedded picture; nothing else.
const LINKS = /\s+((?:xlink:)?href)\s*=\s*("([^"]*)"|'([^']*)')/gi;
const STYLE_URLS = /url\(\s*(['"]?)(?!#)[^)]*\)/gi;
const IMPORTS = /@import[^;]*;?/gi;

export function sanitizeSvg(xml: string): string {
  return xml
    .replace(BLOCKS, "")
    .replace(HANDLERS, "")
    .replace(LINKS, (whole, _name, _quoted, double, single) => {
      const value = String(double ?? single ?? "").trim();
      return value.startsWith("#") || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)
        ? whole
        : "";
    })
    .replace(IMPORTS, "")
    .replace(STYLE_URLS, "none");
}

/** Width over height, from the root element's viewBox or size; 1 when neither is usable. */
export function svgRatio(xml: string): number {
  const root = /<svg\b[^>]*>/i.exec(xml)?.[0] ?? "";
  const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  const size = (name: string) =>
    Number.parseFloat(
      new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(root)?.[1] ?? "",
    );
  const [w, h] = box ? [Number(box[1]), Number(box[2])] : [size("width"), size("height")];
  return w > 0 && h > 0 && Number.isFinite(w / h) ? Math.min(Math.max(w / h, 0.1), 10) : 1;
}
