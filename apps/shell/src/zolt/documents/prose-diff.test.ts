import { describe, expect, it } from "vitest";
import { anchorFor, locateAnchor } from "../../shared/document-anchors";
import { acceptChange, describeChange, proseDiff, rejectChange } from "../../shared/prose-diff";

const base = "# Chapter 3\n\nThe rain fell like a curtain.\nShe waited by the door.\n\nThe end.\n";

describe("proseDiff", () => {
  it("finds no changes in equal texts", () => {
    expect(proseDiff(base, base).changes).toEqual([]);
  });

  it("reports a replaced phrase as one change with offsets in both texts", () => {
    const current = base.replace("fell like a curtain", "came down in sheets");
    const { changes, segments } = proseDiff(base, current);
    expect(changes).toHaveLength(1);
    const [change] = changes;
    expect(change.removed).toBe("fell like a curtain");
    expect(change.added).toBe("came down in sheets");
    expect(base.slice(change.baseFrom, change.baseTo)).toBe(change.removed);
    expect(current.slice(change.currentFrom, change.currentTo)).toBe(change.added);
    expect(describeChange(change)).toBe(
      "Replaced “fell like a curtain” with “came down in sheets”",
    );
    const rebuilt = segments
      .map((segment) => (segment.type === "equal" ? segment.text : segment.change.added))
      .join("");
    expect(rebuilt).toBe(current);
  });

  it("joins edits a word or two apart into one change", () => {
    const current = base.replace("waited by the door", "lingered at the gate");
    const { changes } = proseDiff(base, current);
    expect(changes.map((change) => [change.removed, change.added])).toEqual([
      ["waited by the door", "lingered at the gate"],
    ]);
  });

  it("keeps edits in different sentences apart", () => {
    const text = "One cat sat. Then two dogs ran.\n";
    const { changes } = proseDiff(text, text.replace("cat", "bird").replace("dogs", "foxes"));
    expect(changes.map((change) => change.added)).toEqual(["bird", "foxes"]);
  });

  it("keeps separate edits in different paragraphs apart", () => {
    const current = base.replace("rain", "snow").replace("door", "window").replace("end", "finish");
    const { changes } = proseDiff(base, current);
    expect(changes.map((change) => [change.removed, change.added])).toEqual([
      ["rain", "snow"],
      ["door", "window"],
      ["end", "finish"],
    ]);
  });

  it("handles added and removed paragraphs", () => {
    const current = `${base.replace("She waited by the door.\n", "")}\nAn epilogue.\n`;
    const { changes } = proseDiff(base, current);
    expect(changes.some((change) => change.removed.includes("She waited"))).toBe(true);
    expect(changes.some((change) => change.added.includes("An epilogue."))).toBe(true);
  });

  it("accepting every change turns the baseline into the current text", () => {
    const current = base.replace("rain", "snow").replace("The end.", "Fin.\n\nCredits.");
    let baseline = base;
    for (;;) {
      const [change] = proseDiff(baseline, current).changes;
      if (!change) break;
      baseline = acceptChange(baseline, change);
    }
    expect(baseline).toBe(current);
  });

  it("rejecting every change turns the current text back into the baseline", () => {
    let current = `${base.replace("rain", "snow").replace("door", "gate")}More.\n`;
    for (;;) {
      const [change] = proseDiff(base, current).changes;
      if (!change) break;
      current = rejectChange(current, change);
    }
    expect(current).toBe(base);
  });

  it("rejecting one change keeps the others", () => {
    const current = base.replace("rain", "snow").replace("door", "gate");
    const changes = proseDiff(base, current).changes;
    const kept = rejectChange(current, changes[0]);
    expect(kept).toBe(base.replace("door", "gate"));
  });

  it("copes with long texts", () => {
    const long = Array.from({ length: 4000 }, (_, i) => `Line ${i} of the long book.\n`).join("");
    const edited = long.replace("Line 2000 of", "Line two thousand of");
    const { changes } = proseDiff(long, edited);
    expect(changes).toHaveLength(1);
    expect(changes[0].added).toBe("two thousand");
  });
});

describe("anchors", () => {
  it("finds the quoted passage again after edits elsewhere", () => {
    const text = "Alpha beta gamma. Alpha beta delta.";
    const from = text.lastIndexOf("Alpha beta");
    const anchor = anchorFor(text, from, from + "Alpha beta".length);
    const edited = `Intro. ${text}`;
    const found = locateAnchor(edited, anchor);
    expect(found?.from).toBe(edited.lastIndexOf("Alpha beta"));
  });

  it("returns null once the passage is gone", () => {
    const anchor = anchorFor("one two three", 4, 7);
    expect(locateAnchor("one three", anchor)).toBeNull();
  });
});
