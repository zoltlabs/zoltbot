import { describe, expect, it } from "vitest";

/**
 * Captions that restate a label keep coming back through class names like `*-hint`. New code
 * can't add one; text that a person needs goes in a kit prop such as `consequence` or `error`.
 */
const CAPTION = /[a-z0-9-]*(?:hint|caption|subtitle|description|helper)[a-z0-9-]*/g;

/** Classes that look like captions but aren't, with the reason. */
const ALLOWED: Record<string, string> = {
  "agent-settings-description": "the field that edits the agent's description",
  "media-caption": "the file name and actions bar under a media preview",
  "link-card-description": "the linked page's own summary, shown on its card",
};

const SOURCES = import.meta.glob<string>(["./**/*.{tsx,css}", "!./**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Class names in TSX class attributes and CSS selectors that look like captions. */
function captionClasses(source: string, css: boolean): string[] {
  const places = css
    ? [...source.matchAll(/(?:^|[\s,>+~}])\.([a-z][\w-]*)/gm)].map((match) => match[1] ?? "")
    : [...source.matchAll(/class(?:List)?=\{?["'`{]([^"'`}]*)/g)].map((match) => match[1] ?? "");
  return [...new Set(places.flatMap((place) => place.match(CAPTION) ?? []))];
}

describe("caption classes", () => {
  it("are found in TSX and CSS", () => {
    expect(captionClasses('<p class="models-hint">x</p>', false)).toEqual(["models-hint"]);
    expect(captionClasses(".row-subtitle { color: red }", true)).toEqual(["row-subtitle"]);
    expect(captionClasses('<p class="models-note">x</p>', false)).toEqual([]);
  });

  it("aren't used outside the allowed list", () => {
    const found = Object.entries(SOURCES).flatMap(([path, source]) =>
      captionClasses(source, path.endsWith(".css"))
        .filter((name) => !(name in ALLOWED))
        .map((name) => `${path}: ${name}`),
    );
    expect(found).toEqual([]);
  });
});
