import { expect, it } from "vitest";
import { macPrefixCandidate, macPrefixMatches } from "./mac-prefix.js";

it("offers a specific parsed prefix and no broad or sensitive command choice", () => {
  expect(macPrefixCandidate("pnpm test --filter core")).toBe("pnpm test");
  expect(macPrefixCandidate("pnpm run verify -- --verbose")).toBe("pnpm run verify");
  for (const command of [
    "uname",
    "sudo uname",
    "pnpm test security",
    "pnpm exec anything",
    "git status; uname",
    "node -e code",
  ])
    expect(macPrefixCandidate(command)).toBeUndefined();
});

it.each([
  ["pnpm test", "pnpm test --filter example"],
  ["git status", "git status --short"],
  ["pnpm run verify", "pnpm run verify -- --verbose"],
  ["git diff", "git diff 'a file.ts'"],
  ["uname -a", "uname -a"],
])("matches %s by complete parsed arguments", (prefix, command) => {
  expect(macPrefixMatches(prefix, command)).toBe(true);
});
it.each([
  ["pnpm", "pnpm test"],
  ["pnpm test", "pnpm testing"],
  ["pnpm test", "pnpm test; security find-generic-password"],
  ["pnpm test", "pnpm test $(uname)"],
  ["pnpm test", "pnpm test\nuname"],
  ["pnpm test", "pnpm test > output"],
  ["pnpm test", "pnpm test | sh"],
  ["pnpm test", "pnpm test `uname`"],
  ["pnpm test", "pnpm test *"],
  ["pnpm test", "pnpm test 'unclosed"],
  ["pnpm test", "pnpm test sudo"],
  ["pnpm test", "pnpm test /usr/bin/security"],
  ["sudo uname", "sudo uname -a"],
  ["defaults read", "defaults read global"],
  ["systemsetup -gettimezone", "systemsetup -gettimezone"],
  ["zsh -lc", "zsh -lc uname"],
  ["/bin/sh -c", "/bin/sh -c uname"],
  ["python3.14 -I", "python3.14 -I -c code"],
  ["busybox sh", "busybox sh -c uname"],
  ["git -C", "git -C /tmp status"],
  ["git --git-dir", "git --git-dir /tmp/repo status"],
  ["open -a", "open -a Calculator"],
  ["pnpm --dir", "pnpm --dir /tmp test"],
  ["env PATH=/tmp", "env PATH=/tmp uname"],
  ["node -e", "node -e code"],
  ["pnpm exec", "pnpm exec anything"],
  ["pnpm run", "pnpm run anything"],
  ["git status", "A=1 git status"],
  ["git status", "git status && uname"],
])("requires a fresh command approval for %s → %s", (prefix, command) => {
  expect(macPrefixMatches(prefix, command)).toBe(false);
});
