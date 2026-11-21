import { expect, it } from "vitest";
import { findSecret, vaultReference } from "./secret-detect.js";

const found = (text: string) => {
  const match = findSecret(text);
  return match ? text.slice(match.start, match.end) : undefined;
};

it("finds well-known key shapes and keeps the text around them", () => {
  const github = `ghp_${"a1B2".repeat(9)}`;
  expect(found(`use ${github} for the repo`)).toBe(github);
  const openai = `sk-proj-${"Xy9_".repeat(6)}`;
  expect(found(openai)).toBe(openai);
  // Fixtures are put together here so secret scanners don't read them as real keys.
  const aws = `AKIA${"ABCDEFGHIJKLMNOP"}`;
  expect(found(`${aws} is the key`)).toBe(aws);
  expect(found("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe(
    "abcdefghijklmnopqrstuvwxyz012345",
  );
  const password = ["Synthetic", "Pass", "1234"].join("-");
  expect(found(`the password: ${password} works`)).toBe(password);
  const key = `abcdEFGH${"12345678"}`;
  expect(found(`api_key=${key}`)).toBe(key);
  expect(
    findSecret("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"),
  ).toMatchObject({ kind: "private_key" });
  expect(found("x7#Kp2$mQ9!vLw4z")).toBe("x7#Kp2$mQ9!vLw4z");
});

it("leaves ordinary text, hashes, ids and links alone", () => {
  for (const text of [
    "Can you fix the login page?",
    "3f786850e387550fdab836ed7e6dc881de23001b",
    "3f78685",
    "5f0c1c1e-0000-4000-8000-000000000000",
    "https://github.com/example/repo/pull/12",
    "owner@example.test",
    "packages/daemon/src/vault/api.ts",
    "TypeScript2026",
    "Please reset my password tomorrow",
    "the sk-learn version",
  ])
    expect(findSecret(text), text).toBeUndefined();
});

it("writes a reference the agent can name without the value", () => {
  expect(vaultReference("GitHub token")).toBe("[vault: GitHub token]");
  expect(vaultReference("a]b\nc")).toBe("[vault: a b c]");
});
