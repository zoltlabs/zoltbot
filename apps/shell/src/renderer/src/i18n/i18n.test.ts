import { afterEach, describe, expect, it } from "vitest";
import mobileFormat from "../../../../../mobile/src/i18n/format.ts?raw";
import en from "./en.json";
import { formatMessage, messageArguments, parseMessage } from "./format";
import desktopFormat from "./format.ts?raw";
import { formatList, formatNumber, setLocale, t } from "./index";
import baseline from "./jsx-text-baseline.json";

/** Every source file in the renderer except tests, keyed by its path from `src/`. */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, text]) => [path.replace(/^\.\.\//, ""), text]),
);

describe("message format", () => {
  it("fills arguments, numbers, plurals and selects", () => {
    expect(formatMessage("Hi {name}", { name: "Ada" }, "en")).toBe("Hi Ada");
    expect(formatMessage("{count, number} runs", { count: 1200 }, "en")).toBe("1,200 runs");
    const queued = "{count, plural, =0 {Nothing queued} one {# message} other {# messages}}";
    expect(formatMessage(queued, { count: 0 }, "en")).toBe("Nothing queued");
    expect(formatMessage(queued, { count: 1 }, "en")).toBe("1 message");
    expect(formatMessage(queued, { count: 2400 }, "en")).toBe("2,400 messages");
    const who = "{author, select, you {You} other {Agent}}";
    expect(formatMessage(who, { author: "you" }, "en")).toBe("You");
    expect(formatMessage(who, { author: "bot" }, "en")).toBe("Agent");
    expect(formatMessage("'{literal}' and it''s", {}, "en")).toBe("{literal} and it's");
  });

  it("rejects broken messages and missing parameters", () => {
    expect(() => parseMessage("{count, plural, one {#}}")).toThrow(/other/);
    expect(() => parseMessage("{name")).toThrow();
    expect(() => formatMessage("Hi {name}", {}, "en")).toThrow(/name/);
    expect(messageArguments("{a} {n, plural, other {{b}}}")).toEqual(["a", "b", "n"]);
  });

  it("is the same file on the phone", () => {
    expect(mobileFormat).toBe(desktopFormat);
  });
});

describe("t()", () => {
  afterEach(() => setLocale("en"));

  it("formats catalog messages and falls back to English for unknown locales", () => {
    expect(t("chat.message.react", { emoji: "🎉" })).toBe("React with 🎉");
    setLocale("xx");
    expect(t("chat.message.replyTo", { author: "you" })).toBe("Reply to User message");
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatList(["Ada", "Kai", "Mo"])).toBe("Ada, Kai, and Mo");
  });
});

describe("catalog", () => {
  const calls = Object.entries(SOURCES).flatMap(([file, text]) => {
    return [...text.matchAll(/\bt\(\s*"([\w.-]+)"\s*(?:,\s*(\{[^}]*\}))?/g)].map((match) => ({
      file,
      key: match[1] ?? "",
      params: match[2],
    }));
  });

  it("parses every message", () => {
    for (const [key, source] of Object.entries(en)) {
      expect(() => parseMessage(source), key).not.toThrow();
    }
  });

  it("has every key the code uses, with the placeholders the message needs", () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const source = (en as Record<string, string>)[call.key];
      expect(source, `${call.file}: unknown key ${call.key}`).toBeDefined();
      if (!source || call.params === undefined) continue;
      // Keys of an object literal: `name: value` or shorthand `name`.
      const given = [...call.params.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)]
        .map((match) => match[1])
        .sort();
      expect(given, `${call.file}: ${call.key}`).toEqual(messageArguments(source));
    }
  });

  it("has no unused keys", () => {
    // A key also counts as used when code passes it around, such as a menu entry's label.
    const all = Object.values(SOURCES).join("\n");
    const unused = Object.keys(en).filter((key) => !all.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });
});

/**
 * Text written straight into JSX can't be translated. Files that had it when translations
 * started are listed in jsx-text-baseline.json and move to t() in passes; every other file must
 * use t(). Remove a file from the list once it is clean.
 */
describe("JSX text", () => {
  const TEXT = />\s*([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*?)\s*</g;
  const PROP = /\b(?:aria-label|label|title|placeholder|alt)="([^"]*[A-Za-z]{2}[^"]*)"/g;
  const listed = new Set<string>(baseline);
  const files = Object.keys(SOURCES).filter(
    (file) => file.endsWith(".tsx") && !/(KitGallery|DesignFixtures)\.tsx$/.test(file),
  );

  function literals(file: string): string[] {
    const text = (SOURCES[file] ?? "").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...text.matchAll(TEXT), ...text.matchAll(PROP)].map((match) => match[1] ?? "");
  }

  it("is not added to files outside the baseline", () => {
    const offenders = files
      .filter((file) => !listed.has(file))
      .map((file) => ({ file: file, text: literals(file) }))
      .filter((entry) => entry.text.length > 0);
    expect(offenders).toEqual([]);
  });

  it("lists only files that still have it", () => {
    const clean = files
      .filter((file) => listed.has(file))
      .filter((file) => literals(file).length === 0)
      .map((file) => file);
    expect(clean).toEqual([]);
  });
});
