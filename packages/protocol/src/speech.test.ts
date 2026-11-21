import { describe, expect, it } from "vitest";
import { SpeechQueue } from "./speech-queue.js";
import { CODE_OMITTED, speechPieces, speechText } from "./speech-text.js";

describe("speechText", () => {
  it("strips Markdown and reads links and pictures as their text", () => {
    expect(
      speechText(
        "## Done\n\n**Tests pass** and _lint_ is ~~red~~ clean. See [the PR](https://x.dev/1) or ![a chart](c.png).\n\n> quoted\n\n- one\n- [x] two",
        "en-US",
      ),
    ).toBe("Done\n\nTests pass and lint is red clean. See the PR or a chart.\n\nquoted\n\none two");
  });

  it("says Code omitted once for each run of code blocks", () => {
    const text = speechText(
      "Run this:\n\n```sh\nnpm i\n```\n\n```js\nx()\n```\n\nThen `npm test`.",
      "en-US",
    );
    expect(text).toBe(`Run this:\n\n${CODE_OMITTED}\n\nThen npm test.`);
    expect(speechText("Before\n\n    indented()\n    code()\n\nAfter", "en-US")).toBe(
      `Before\n\n${CODE_OMITTED}\n\nAfter`,
    );
    // Long blocks and blocks without blank lines around them.
    expect(
      speechText("Intro.\n```js\nconst a = 1;\nconst b = 2;\nlog(a + b);\n```\nAfter.", "en-US"),
    ).toBe(`Intro.\n\n${CODE_OMITTED}\n\nAfter.`);
    // An unclosed block still isn't read.
    expect(speechText("Look:\n```\nsecret()", "en-US")).toBe(`Look:\n\n${CODE_OMITTED}`);
  });

  it("groups long numbers by the reader's locale and leaves versions and ids alone", () => {
    expect(speechText("It used 1234567 tokens in v1.20003 at 12:30, issue 12345.", "en-US")).toBe(
      "It used 1,234,567 tokens in v1.20003 at 12:30, issue 12,345.",
    );
    expect(speechText("1234567 Zeilen", "de-DE")).toBe("1.234.567 Zeilen");
    expect(speechText("commit a1b2c 98765abc", "en-US")).toBe("commit a1b2c 98765abc");
  });

  it("keeps comparisons, and prepares a huge reply quickly", () => {
    expect(speechText("If a < 5 and b > 3 then go.", "en-US")).toBe("If a < 5 and b > 3 then go.");
    const started = performance.now();
    speechText(" \n".repeat(80_000) + "[".repeat(5_000) + "**y ".repeat(5_000), "en-US");
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("reads bare addresses as the site, table rows as lists, and drops HTML", () => {
    expect(speechText("Open https://www.example.com/a?b=1 now <br>", "en-US")).toBe(
      "Open example.com now",
    );
    expect(speechText("| Name | Size |\n| --- | ---: |\n| a | 2 |", "en-US")).toBe(
      "Name, Size.\n\na, 2.",
    );
  });
});

describe("speechPieces", () => {
  it("splits at sentence ends and breaks very long sentences", () => {
    expect(speechPieces("One. Two!\n\nThree?", 8)).toEqual(["One.", "Two!", "Three?"]);
    expect(speechPieces("One. Two.", 20)).toEqual(["One. Two."]);
    expect(speechPieces("你好。再见！", 3)).toEqual(["你好。", "再见！"]);
    const long = `${"word ".repeat(100)}end.`;
    const pieces = speechPieces(long, 60);
    expect(pieces.every((piece) => piece.length <= 60)).toBe(true);
    expect(pieces.join(" ")).toBe(long.trim());
  });
});

function mockEngine() {
  const spoken: string[] = [];
  const pending: (() => void)[] = [];
  return {
    spoken,
    finish: () => pending.shift()?.(),
    engine: {
      speak: (text: string, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          spoken.push(text);
          pending.push(resolve);
          signal.addEventListener("abort", () => resolve());
        }),
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SpeechQueue", () => {
  it("reads a new reply after the current one, and Stop clears the queue", async () => {
    const mock = mockEngine();
    const reading: (string | undefined)[] = [];
    const queue = new SpeechQueue(() => mock.engine, { onReading: (id) => reading.push(id) });
    queue.enqueue("a", ["a1", "a2"]);
    queue.enqueue("b", ["b1"]);
    queue.enqueue("b", ["b1"]);
    expect(queue.reading).toBe("a");
    expect(queue.queued).toEqual(["b"]);
    mock.finish();
    await tick();
    expect(mock.spoken).toEqual(["a1", "a2"]);
    mock.finish();
    await tick();
    expect(queue.reading).toBe("b");
    queue.enqueue("c", ["c1"]);
    queue.stop();
    await tick();
    expect(queue.reading).toBeUndefined();
    expect(queue.queued).toEqual([]);
    expect(mock.spoken).toEqual(["a1", "a2", "b1"]);
    expect(reading.at(-1)).toBeUndefined();
  });

  it("reads now over what's playing, and moves on after an error", async () => {
    const mock = mockEngine();
    const errors: string[] = [];
    let fail = true;
    const queue = new SpeechQueue(
      () => ({
        speak: (text, signal) => {
          if (fail && text === "x1") return Promise.reject(new Error("no voice"));
          return mock.engine.speak(text, signal);
        },
      }),
      { onError: (id) => errors.push(id) },
    );
    queue.enqueue("a", ["a1"]);
    queue.readNow("b", ["b1"]);
    await tick();
    expect(queue.reading).toBe("b");
    expect(mock.spoken).toEqual(["a1", "b1"]);
    // The first resolver is "a1", already ended by Read now.
    mock.finish();
    mock.finish();
    queue.enqueue("x", ["x1"]);
    queue.enqueue("y", ["y1"]);
    await tick();
    await tick();
    expect(errors).toEqual(["x"]);
    expect(queue.reading).toBe("y");
    fail = false;
  });
});
