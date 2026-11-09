import type { ApprovalRule } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { decideApproval, matchApprovalRule, tokenizeCommand } from "./approval-rules.js";

const at = "2026-10-28T12:00:00.000Z";
const request = {
  tool: "Bash",
  kind: "execute" as const,
  command: "git status --short",
  agentId: "profile",
  projectId: "project",
};
const rule: ApprovalRule = {
  id: "rule",
  scope: "global",
  matcher: { tool: "Bash", command: { prefix: ["git", "status"] } },
  decision: "allow",
  createdBy: { kind: "human", id: "owner" },
  createdAt: at,
};
it("tokenizes quoted argv, preserves arguments, and rejects ambiguous or compound shell syntax", () => {
  expect(tokenizeCommand("git commit -m 'two words'")).toEqual([
    "git",
    "commit",
    "-m",
    "two words",
  ]);
  expect(tokenizeCommand('git status ""')).toEqual(["git", "status", ""]);
  expect(tokenizeCommand("git status\\ --short")).toEqual(["git", "status --short"]);
  for (const command of [
    "",
    "git 'status",
    "git status\\",
    "A=b git status",
    "git status\nrm a",
    "git status\0",
  ])
    expect(tokenizeCommand(command)).toBeUndefined();
});
it("never matches a command prefix across generated shell operators or substitutions", () => {
  const operators = [
    "|",
    "||",
    "&&",
    ";",
    ">",
    "<",
    "2>",
    "&",
    "$(echo hidden)",
    "`echo hidden`",
    "\n",
    "\r",
    "#",
    "$" + "{HOME}",
    "<(echo hidden)",
  ];
  for (const operator of operators)
    for (const spacing of ["", " ", "\t"])
      for (const suffix of ["echo x", "rm -rf x", "git status"])
        expect(
          matchApprovalRule(
            rule,
            { ...request, command: `git status${spacing}${operator}${spacing}${suffix}` },
            at,
          ),
        ).toBe(false);
  expect(matchApprovalRule(rule, request, at)).toBe(true);
  expect(matchApprovalRule(rule, { ...request, command: "git status-other" }, at)).toBe(false);
});
it("applies deny precedence before scope and project scope before global", () => {
  const project = { ...rule, id: "project-rule", scope: "project" as const, scopeId: "project" };
  const deny = { ...rule, id: "deny", decision: "deny" as const };
  expect(decideApproval([rule, project], request, at)?.id).toBe("project-rule");
  expect(decideApproval([project, deny], request, at)?.id).toBe("deny");
  expect(decideApproval([{ ...project, scopeId: "another" }], request, at)).toBeUndefined();
  expect(decideApproval([{ ...rule, revokedAt: at }], request, at)).toBeUndefined();
  expect(decideApproval([{ ...rule, expiresAt: at }], request, at)).toBeUndefined();
  expect(decideApproval([rule], request, "invalid")).toBeUndefined();
});
it("never auto allows destructive patterns or a broad execution rule", () => {
  const broad = { ...rule, matcher: { tool: "Bash" } };
  expect(matchApprovalRule(broad, request, at)).toBe(false);
  for (const command of [
    "rm -rf cache",
    "rm -r -f cache",
    "git push --force",
    "git push --force-with-lease",
    "git reset --hard",
    "sqlite data.db 'DROP TABLE users'",
    "bash -c 'rm -rf cache'",
    "git -c alias.x=anything status",
    "find . -delete",
    "git -calias.x=anything status",
    "git --git-dir=/outside commit",
    "cp local /outside/file",
    "cp local ../outside/file",
  ])
    expect(
      matchApprovalRule(
        {
          ...rule,
          matcher: { tool: "Bash", command: { prefix: [command.split(" ")[0] as string] } },
        },
        { ...request, command },
        at,
      ),
    ).toBe(false);
});
it("matches only verified workspace paths and exact network or MCP constraints", () => {
  const paths = { ...rule, matcher: { tool: "edit", paths: ["src/**", "tests/*.ts"] } };
  const edit = {
    tool: "Write",
    kind: "edit" as const,
    agentId: "profile",
    paths: ["src/a/b.ts", "tests/one.ts"],
    pathsVerified: true,
  };
  expect(matchApprovalRule(paths, edit, at)).toBe(true);
  for (const path of ["../outside", "/absolute", "src/../../outside", "other/a.ts"])
    expect(matchApprovalRule(paths, { ...edit, paths: [path] }, at)).toBe(false);
  expect(matchApprovalRule(paths, { ...edit, pathsVerified: false }, at)).toBe(false);
  expect(
    matchApprovalRule(
      { ...rule, matcher: { tool: "fetch", host: "example.com" } },
      { tool: "fetch", agentId: "profile", host: "example.com.evil.test" },
      at,
    ),
  ).toBe(false);
  const mcp = { ...rule, matcher: { tool: "mcp", mcp: { server: "trusted", tool: "read" } } };
  expect(
    matchApprovalRule(
      mcp,
      { tool: "mcp", agentId: "profile", mcp: { server: "trusted", tool: "write" } },
      at,
    ),
  ).toBe(false);
});
