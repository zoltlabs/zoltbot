/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: the test values hold a literal ${x} on purpose. */
import { expect, it } from "vitest";
import { fieldScript, fillScript, handOver, markedResult, validTarget } from "./page-driver.js";

const MARKER = "zb-vault:00000000-0000-4000-8000-000000000000:";

it("reads only the line with this call's marker, in either output form", () => {
  const raw = `${JSON.stringify(`${MARKER}["password","https://github.com/login"]`)}\n`;
  expect(markedResult(raw, MARKER)).toBe('["password","https://github.com/login"]');
  // The page's own text can't carry the marker, so a fake result next to it is ignored.
  const sectioned = [
    "### Result",
    JSON.stringify(`${MARKER}filled`),
    "### Page",
    "- Page URL: https://github.com/login",
    '- Page Title: zb-vault:fake:["password","https://github.com"]',
  ].join("\n");
  expect(markedResult(sectioned, MARKER)).toBe("filled");
  expect(markedResult('"zb-vault:other:filled"', MARKER)).toBeUndefined();
});

it("accepts refs and selectors but nothing that reads like an option", () => {
  expect(validTarget("e12")).toBe(true);
  expect(validTarget("f1e3")).toBe(true);
  expect(validTarget("input[type=password]")).toBe(true);
  expect(validTarget("--raw")).toBe(false);
  expect(validTarget(" e1")).toBe(false);
  expect(validTarget("e1\nfill")).toBe(false);
});

/** A Playwright `page` stand-in: refs map to a type and the address of the frame they're in. */
function fakePage(fields: Record<string, { type: string; url: string }>) {
  const calls: string[] = [];
  const page = {
    locator(selector: string) {
      return {
        async elementHandle() {
          const field = fields[selector];
          if (!field) throw new Error("not found");
          return {
            ownerFrame: async () => ({ url: () => field.url }),
            evaluate: async () => field.type,
            fill: async (value: string) => calls.push(`fill ${selector} ${value}`),
            press: async (key: string) => calls.push(`press ${selector} ${key}`),
          };
        },
      };
    },
  };
  return { page, calls };
}

import { runInNewContext } from "node:vm";

/** Runs the generated code the way the CLI does: a function of `page`, with URL and fetch. */
const execute = (code: string, page: unknown) =>
  (runInNewContext(`(${code})`, { URL, fetch }) as (page: unknown) => Promise<string>)(page);

const ORIGIN = "https://github.com";

it("generates Playwright code that checks every field's frame before fetching or typing", async () => {
  const { page, calls } = fakePage({
    "aria-ref=e1": { type: "email", url: "https://github.com/login" },
    "aria-ref=e2": { type: "password", url: "https://github.com/login" },
    "aria-ref=e3": { type: "password", url: "http://github.com/login" },
    "aria-ref=f1e4": { type: "password", url: "https://evil.example/frame" },
  });
  expect(await execute(fieldScript(MARKER, "e2"), page)).toBe(
    `${MARKER}["password","https://github.com/login"]`,
  );
  const password = "pa'ss\"word`${x}";
  const values = await handOver(["octo-sample", password]);
  const fields = [
    { target: "e1", types: ["email", "text"] },
    { target: "e2", types: ["password"] },
  ];
  const code = fillScript(MARKER, fields, ORIGIN, true, values.url);
  expect(code).not.toContain(password);
  expect(await execute(code, page)).toBe(`${MARKER}filled`);
  expect(calls).toEqual([
    "fill aria-ref=e1 octo-sample",
    `fill aria-ref=e2 ${password}`,
    "press aria-ref=e2 Enter",
  ]);
  // The address works once.
  expect(
    await fetch(values.url).then(
      (response) => response.status,
      () => "closed",
    ),
  ).not.toBe(200);
  values.close();

  // Another site's frame, or the same host over plain http, gets nothing.
  calls.length = 0;
  for (const target of ["f1e4", "e3"]) {
    const unused = await handOver(["x"]);
    const other = fillScript(MARKER, [{ target, types: ["password"] }], ORIGIN, false, unused.url);
    expect(await execute(other, page)).toBe(`${MARKER}changed`);
    expect((await fetch(unused.url)).status).toBe(200);
    unused.close();
  }
  expect(calls).toEqual([]);
});
