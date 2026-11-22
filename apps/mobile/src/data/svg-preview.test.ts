import { describe, expect, it } from "vitest";
import { sanitizeSvg, svgRatio } from "./svg-preview";

describe("sanitizeSvg", () => {
  it("removes scripts, handlers and links that leave the file", () => {
    const xml = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>alert(1)</script>` +
        `<foreignObject><div/></foreignObject>` +
        `<image href="https://example.invalid/a.png"/><image xlink:href='//example.invalid/b.png'/>` +
        `<use href="#dot"/><image href="data:image/png;base64,AAAA"/>` +
        `<style>@import url(https://example.invalid/x.css); rect{fill:url(http://example.invalid/p)}</style>` +
        `<rect fill="url(#grad)" onclick="y()"/></svg>`,
    );
    expect(xml).not.toMatch(/script|foreignObject|onload|onclick|example\.invalid|@import/);
    expect(xml).toContain('href="#dot"');
    expect(xml).toContain('href="data:image/png;base64,AAAA"');
    expect(xml).toContain("url(#grad)");
    expect(xml).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});

describe("svgRatio", () => {
  it("reads the viewBox, then the size, and stays sane", () => {
    expect(svgRatio('<svg viewBox="0 0 200 100">')).toBe(2);
    expect(svgRatio('<svg width="50px" height="100">')).toBe(0.5);
    expect(svgRatio("<svg>")).toBe(1);
    expect(svgRatio('<svg viewBox="0 0 100000 1">')).toBe(10);
  });
});
