/** Search cache only: never used to sanitize or render untrusted content. */
export function artifactSearchText(mime: string, text: string) {
  const bounded = text.slice(0, 256 * 1024);
  if (mime === "text/html" || mime === "image/svg+xml")
    return bounded
      .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(
        /&(amp|lt|gt|quot|apos|nbsp);/g,
        (_, name: string) =>
          ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[name] ?? " ",
      )
      .replace(/\s+/g, " ")
      .slice(0, 16000);
  return ["text/markdown", "text/plain", "text/csv"].includes(mime) ? bounded.slice(0, 16000) : "";
}
