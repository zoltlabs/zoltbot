import { expect, it } from "vitest";
import { macOnlyMethods, methodCatalog } from "./catalog.js";
import { CloudProjectCreateSchema, CommandActorSchema, localCommandActor } from "./cloud.js";
import { parse } from "./common.js";
import { parseRequest } from "./validation.js";

it("classifies every method and derives Mac-only phone restrictions from catalog metadata", () => {
  for (const [name, method] of Object.entries(methodCatalog)) {
    expect(["local", "cloud", "both"], name).toContain(method.where);
    expect(typeof method.pairedPhone, name).toBe("boolean");
    expect(macOnlyMethods.includes(name as keyof typeof methodCatalog)).toBe(!method.pairedPhone);
  }
  expect(methodCatalog["cloud.project.create"].where).toBe("cloud");
  expect(methodCatalog["task.review"].where).toBe("both");
  expect(methodCatalog["detect.startLogin"].where).toBe("local");
  expect(methodCatalog["device.list"].pairedPhone).toBe(true);
});
it("attributes commands to the authenticated caller and preserves local compatibility", () => {
  const input = {
    jsonrpc: "2.0",
    id: 1,
    method: "snapshot.get",
    params: {},
    actor: { userId: "forged", deviceId: "forged", surface: "system" },
  };
  expect(parseRequest(input).actor).toEqual(localCommandActor());
  expect(parseRequest(input, localCommandActor("phone")).actor).toEqual({
    userId: "local-owner",
    deviceId: "phone",
    surface: "phone",
  });
  const actor = { userId: "member", deviceId: "device", surface: "desktop" as const };
  expect(parseRequest(input, actor).actor).toEqual(actor);
  expect(() => parse(CommandActorSchema, { ...actor, userId: "" })).toThrow();
});
it("validates cloud repository inputs and task locations", () => {
  expect(() =>
    parse(CloudProjectCreateSchema, {
      name: "Synthetic",
      repository: "owner/repo",
      defaultBranch: "main",
      setupScript: "pnpm install",
    }),
  ).not.toThrow();
  for (const repository of [
    "/tmp/repo",
    "https://example.invalid/repo",
    "owner/repo/extra",
    "owner/",
  ])
    expect(() =>
      parse(CloudProjectCreateSchema, {
        name: "Synthetic",
        repository,
        defaultBranch: "main",
        setupScript: "",
      }),
    ).toThrow();
  expect(() =>
    parse(methodCatalog["task.create"].params, {
      title: "Synthetic",
      brief: "Synthetic",
      profileId: "profile",
      node: { type: "project", id: "project" },
      location: "sandbox",
    }),
  ).not.toThrow();
});
