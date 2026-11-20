import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "./en.json";
import { messageArguments, parseMessage } from "./format";
import { setLocale, t } from "./index";

const SRC = fileURLToPath(new URL("..", import.meta.url).href);

function sourceFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("phone catalog", () => {
  const calls = sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\bt\(\s*"([\w.-]+)"\s*(?:,\s*(\{[^}]*\}))?/g)].map(
      (match) => ({ file: relative(SRC, file), key: match[1] ?? "", params: match[2] }),
    ),
  );

  it("parses every message and has every key the code uses", () => {
    for (const [key, source] of Object.entries(en))
      expect(() => parseMessage(source), key).not.toThrow();
    for (const call of calls) {
      const source = (en as Record<string, string>)[call.key];
      expect(source, `${call.file}: unknown key ${call.key}`).toBeDefined();
      if (!source || call.params === undefined) continue;
      const given = [...call.params.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[:,}])/g)]
        .map((match) => match[1])
        .sort();
      expect(given, `${call.file}: ${call.key}`).toEqual(messageArguments(source));
    }
  });

  it("has no unused keys and falls back to English", () => {
    const used = new Set(calls.map((call) => call.key));
    expect(Object.keys(en).filter((key) => !used.has(key))).toEqual([]);
    setLocale("xx");
    expect(t("kit.cancel")).toBe("Cancel");
    setLocale("en");
  });
});
