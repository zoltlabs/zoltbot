import { describe, expect, it } from "vitest";
import { LANGUAGES, normalizePreferences } from "../../../shared/preferences";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import { formatMessage } from "./format";
import fr from "./fr.json";
import { LANGUAGE_NAMES, locale, resolveLanguage, setLocale, t } from "./index";
import ja from "./ja.json";
import ptBR from "./pt-BR.json";
import zhCN from "./zh-CN.json";

const catalogs: Record<string, Record<string, string>> = {
  es,
  de,
  fr,
  ja,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
};

/**
 * The argument names a message uses. A brace opens an argument unless it is inside an argument's
 * options, where it opens a plural or select branch, whose text is translated.
 */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  const stack: ("argument" | "branch")[] = [];
  for (let index = 0; index < message.length; index++) {
    const char = message[index];
    if (char === "'") {
      // ICU quoting: '{' is literal text.
      const end = message.indexOf("'", index + 1);
      if (end > index + 1) index = end;
      continue;
    }
    if (char === "{") {
      if (stack.at(-1) === "argument") stack.push("branch");
      else {
        stack.push("argument");
        const name = /^\s*([^\s,}]+)/.exec(message.slice(index + 1))?.[1];
        if (name) names.add(name);
      }
    } else if (char === "}") stack.pop();
  }
  return [...names].sort();
}

describe("languages (D9)", () => {
  it("follows the system's first language the app comes in", () => {
    expect(resolveLanguage("system", ["de-AT", "en-US"])).toBe("de");
    expect(resolveLanguage("system", ["pt-PT"])).toBe("pt-BR");
    expect(resolveLanguage("system", ["zh-Hans-CN"])).toBe("zh-CN");
    // Traditional Chinese isn't offered, so the next language wins.
    expect(resolveLanguage("system", ["zh-TW", "ja-JP"])).toBe("ja");
    expect(resolveLanguage("system", ["ko-KR"])).toBe("en");
    expect(resolveLanguage("fr", ["de-DE"])).toBe("fr");
  });

  it("saves only languages the app comes in", () => {
    expect(normalizePreferences({ language: "ja" }).language).toBe("ja");
    expect(normalizePreferences({ language: "ko" }).language).toBe("system");
    expect(Object.keys(LANGUAGE_NAMES)).toEqual([...LANGUAGES]);
  });

  for (const [language, catalog] of Object.entries(catalogs)) {
    it(`${language} has every key, with the same placeholders, and each parses`, () => {
      expect(Object.keys(catalog)).toEqual(Object.keys(en));
      for (const [key, message] of Object.entries(en)) {
        const translated = catalog[key] as string;
        expect(translated.trim(), key).not.toBe("");
        expect(placeholders(translated), key).toEqual(placeholders(message));
        const params = Object.fromEntries(placeholders(message).map((name) => [name, 2]));
        expect(() => formatMessage(translated, params, language), key).not.toThrow();
      }
    });
  }

  it("shows the chosen language and falls back to English", () => {
    setLocale("de");
    expect(locale()).toBe("de");
    expect(t("appearance.title")).toBe(de["appearance.title"]);
    setLocale("ko");
    expect(t("appearance.title")).toBe(en["appearance.title"]);
    setLocale("en");
  });
});
