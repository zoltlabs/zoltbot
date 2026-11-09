import { expect, it } from "vitest";
import { assignHues, avatarHue, avatarHues, initials } from "./identity.js";

it("assigns every profile id a stable hue within the avatar palette", () => {
  const ids = Array.from({ length: 200 }, (_, n) => `profile-${n}`);
  const hues = ids.map(avatarHue);
  expect(hues.every((hue) => hue >= 1 && hue <= avatarHues)).toBe(true);
  expect(new Set(hues).size).toBe(avatarHues);
  expect(avatarHue("profile-7")).toBe(avatarHue("profile-7"));
});

it("takes up to two initials and ignores extra whitespace", () => {
  expect(initials("  design   profile  ")).toBe("DP");
  expect(initials("Build profile reviewer")).toBe("BP");
  expect(initials("émile")).toBe("É");
  expect(initials("")).toBe("");
});

it("spreads hues so profiles share none until all eight are used", () => {
  const profiles = Array.from({ length: 12 }, (_, n) => ({
    id: `profile-${n}`,
    createdAt: `2026-10-${String(n + 10)}`,
  }));
  const hues = assignHues(profiles);
  const first = profiles.slice(0, 8).map((p) => hues.get(p.id));
  expect(new Set(first).size).toBe(avatarHues);
  const rest = profiles.slice(8).map((p) => hues.get(p.id));
  expect(new Set(rest).size).toBe(rest.length);
});

it("keeps older profiles' hues when a new profile is added", () => {
  const older = Array.from({ length: 5 }, (_, n) => ({
    id: `p${n}`,
    createdAt: `2026-01-0${n + 1}`,
  }));
  const before = assignHues(older);
  const after = assignHues([...older, { id: "p-new", createdAt: "2026-02-01" }]);
  for (const { id } of older) expect(after.get(id)).toBe(before.get(id));
  expect(assignHues([{ id: "solo" }]).get("solo")).toBe(avatarHue("solo"));
});
