import { describe, expect, it } from "vitest";
import type { SpendRow } from "../../shared/spend";
import {
  CHART_SERIES,
  chartMeasure,
  chartTicks,
  dayKey,
  formatUsdShort,
  labeledDay,
  niceMax,
  OTHER,
  rangeDays,
  seriesColors,
  sortSpend,
  spendByBot,
  spendByDay,
  spendTotals,
} from "./spend";

const row = (
  botId: string,
  at: Date,
  costUsd: number,
  tokens = 10,
  costKnown = true,
): SpendRow => ({
  at: at.toISOString(),
  botId,
  botName: botId.toUpperCase(),
  projectId: null,
  projectName: "",
  model: "sonnet",
  costUsd,
  costKnown,
  tokens,
});

const day = (date: number, hour = 12) => new Date(2026, 0, date, hour);

describe("rangeDays", () => {
  it("starts at local midnight and lists each day, oldest first", () => {
    const { from, days } = rangeDays("7d", new Date(2026, 0, 10, 15));
    expect(from).toEqual(new Date(2026, 0, 4));
    expect(days).toEqual([
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
    expect(rangeDays("today", new Date(2026, 0, 10, 15)).days).toEqual(["2026-01-10"]);
    expect(rangeDays("30d", new Date(2026, 0, 10)).days).toHaveLength(30);
  });
});

describe("spend totals", () => {
  const rows = [
    row("a", day(1), 1, 100),
    row("b", day(1), 3, 50),
    row("a", day(2), 2, 300),
    row("c", day(2), 0, 5, false),
  ];

  it("adds up each chat and marks one with unpriced runs", () => {
    const byBot = spendByBot(rows);
    expect(byBot.find((total) => total.botId === "a")).toMatchObject({ costUsd: 3, tokens: 400 });
    expect(byBot.find((total) => total.botId === "c")?.costKnown).toBe(false);
    expect(spendTotals(rows)).toEqual({ costUsd: 6, costKnown: false, tokens: 455 });
  });

  it("sorts by cost or tokens, largest first, then by name", () => {
    expect(sortSpend(spendByBot(rows), "cost").map((total) => total.botId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortSpend(spendByBot(rows), "tokens").map((total) => total.botId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    const tie = [row("z", day(1), 1), row("m", day(1), 1)];
    expect(sortSpend(spendByBot(tie), "cost").map((total) => total.botId)).toEqual(["m", "z"]);
  });

  it("charts tokens when nothing reported a price", () => {
    expect(chartMeasure(rows)).toBe("cost");
    expect(chartMeasure([row("a", day(1), 0)])).toBe("tokens");
  });
});

describe("spendByDay", () => {
  it("stacks each day by chat and folds the rest into Other", () => {
    const bots = Array.from({ length: CHART_SERIES + 2 }, (_, index) => `bot${index}`);
    const rows = bots.map((id, index) => row(id, day(2), 10 - index));
    const days = [dayKey(day(1)), dayKey(day(2))];
    const chart = spendByDay(rows, days, "cost");
    expect(chart.series.map((series) => series.id)).toEqual([
      ...bots.slice(0, CHART_SERIES),
      OTHER,
    ]);
    expect(chart.days[0]).toEqual({ day: days[0], values: {}, total: 0 });
    expect(chart.days[1]?.values[OTHER]).toBe(5 + 4);
    expect(chart.days[1]?.total).toBe(rows.reduce((sum, each) => sum + each.costUsd, 0));
  });

  it("skips records outside the range", () => {
    const chart = spendByDay([row("a", day(9), 5)], [dayKey(day(1))], "cost");
    expect(chart.days[0]?.total).toBe(0);
  });
});

describe("seriesColors", () => {
  it("keeps each chat's color from the unfiltered view and gives newcomers free slots", () => {
    const overall = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "d" },
      { id: "e" },
      { id: OTHER },
    ];
    const colors = seriesColors([{ id: "c" }, { id: "x" }, { id: OTHER }], overall);
    expect(colors.get("c")).toBe(2);
    expect(colors.get("x")).toBe(0);
    expect(colors.has(OTHER)).toBe(false);
  });
});

describe("niceMax", () => {
  it("rounds up to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.37)).toBe(0.5);
    expect(niceMax(4.2)).toBe(5);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(100)).toBe(100);
  });
});

describe("chart labels", () => {
  it("labels today and every fifth day back on a month", () => {
    const labeled = Array.from({ length: 30 }, (_, index) => index).filter((index) =>
      labeledDay(index, 30),
    );
    expect(labeled).toEqual([4, 9, 14, 19, 24, 29]);
    expect(labeledDay(3, 7)).toBe(true);
  });

  it("keeps whole-token ticks and short dollar ticks", () => {
    expect(chartTicks("tokens", 1)).toEqual([1, 0]);
    expect(chartTicks("cost", 1)).toEqual([1, 0.5, 0]);
    expect(formatUsdShort(2000)).toBe("$2K");
    expect(formatUsdShort(0.5)).toBe("$0.50");
  });
});
