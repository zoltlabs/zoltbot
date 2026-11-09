import { Value } from "@sinclair/typebox/value";
import { entitySchemas, methodCatalog } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { attachmentAccess, composeInput, searchSampleFiles } from "./attachments.js";
import { createClient } from "./client.js";
import { FakeTransport } from "./fake.js";
import { preferenceKey, readClock, readPhonePrefs } from "./preferences.js";
import { macFolder, newProject } from "./projects.js";
import { inspectPush, type PushApi } from "./push.js";

describe("mobile helpers", () => {
  it("uses existing input parts and gates unsupported operations", () => {
    expect(attachmentAccess("relay")).toEqual({ photo: true, file: false, search: false });
    expect(attachmentAccess("relay", "thread").search).toBe(true);
    expect(attachmentAccess("fake").file).toBe(true);
    const input = composeInput(" hello ", [
      { id: "file", label: "Readme", part: { type: "file", path: "/project/README.md" } },
      {
        id: "image",
        label: "Photo",
        part: { type: "image", base64: "aGVsbG8=", mimeType: "image/png" },
      },
    ]);
    expect(
      Value.Check(methodCatalog["turn.send"].params, { threadId: "thread", input, mode: "queue" }),
    ).toBe(true);
    expect(input[0]).toEqual({ type: "text", text: "hello" });
    expect(composeInput("", [])).toEqual([]);
    expect(searchSampleFiles("README").items).toHaveLength(1);
  });
  it("requires an absolute Mac path and builds a real project", () => {
    expect(macFolder("~/Projects/app")).toBeUndefined();
    expect(macFolder(" /Users/me/app ")).toBe("/Users/me/app");
    expect(() => newProject("id", "Name", "relative", new Date().toISOString())).toThrow();
    expect(
      Value.Check(
        entitySchemas.project,
        newProject("id", "Name", "/Users/me/app", new Date().toISOString()),
      ),
    ).toBe(true);
  });
  it("isolates device preferences and ignores malformed values", () => {
    expect(
      readPhonePrefs([{ key: preferenceKey("a", "pushTitles"), value: true }], "a").pushTitles,
    ).toBe(true);
    expect(
      readPhonePrefs([{ key: preferenceKey("a", "pushTitles"), value: "true" }], "a").pushTitles,
    ).toBe(false);
    expect(
      readPhonePrefs([{ key: preferenceKey("a", "pushTitles"), value: true }], "b").pushTitles,
    ).toBe(false);
  });
  it("reads a typed time of day the way the Mac stores it", () => {
    expect(["8:30", "830", "08:30", "2359"].map(readClock)).toEqual([
      "08:30",
      "08:30",
      "08:30",
      "23:59",
    ]);
    expect(["24:00", "8:60", "8", "morning"].map(readClock)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

it("creates, renames and confirms archiving through the fake and reuses saved settings", async () => {
  let saved: import("./transport.js").Row[] = [];
  const fake = new FakeTransport({
    onSettings: (rows) => {
      saved = rows;
    },
  });
  const client = createClient(fake);
  await vi.waitFor(() => expect(client.getState().status).toBe("online"));
  const call = client.getState().call;
  await call("project.create", {
    value: newProject("new", "New", "/Users/me/app", new Date().toISOString()),
  });
  await call("project.update", { id: "new", changes: { name: "Renamed" } });
  await expect(call("project.archive", { id: "new", confirmed: false })).rejects.toThrow("Confirm");
  await call("project.archive", { id: "new", confirmed: true });
  expect(
    client.getState().snapshot.entities.project?.find((row) => row.id === "new"),
  ).toMatchObject({ name: "Renamed", archived: true });
  await call("settings.set", { key: preferenceKey("this-iphone", "notifyResults"), value: false });
  expect(readPhonePrefs((await call("settings.get", {})) as [], "this-iphone").notifyResults).toBe(
    false,
  );
  const restored = new FakeTransport({ settings: saved });
  const reloaded = createClient(restored);
  await vi.waitFor(() => expect(reloaded.getState().status).toBe("online"));
  expect(
    readPhonePrefs(reloaded.getState().snapshot.entities.settings ?? [], "this-iphone")
      .notifyResults,
  ).toBe(false);
  const files = await reloaded
    .getState()
    .call("workspace.files", { threadId: "thread-rate-limits", query: "README" });
  expect(files).toMatchObject({ items: [{ label: "README.md" }] });
  for (const [kind, rows] of Object.entries(reloaded.getState().snapshot.entities))
    for (const row of rows)
      expect(Value.Check(entitySchemas[kind as keyof typeof entitySchemas], row), kind).toBe(true);
  restored.setMacOnline(false);
  await expect(reloaded.getState().call("project.create", {})).rejects.toThrow("offline");
  reloaded.stop();
  client.stop();
});

it("asks only when requested and reads a native APNs token after permission", async () => {
  const permission = { granted: false, canAskAgain: true, status: "undetermined" };
  const api: PushApi = {
    getPermissionsAsync: vi.fn(async () => permission),
    requestPermissionsAsync: vi.fn(async () => ({
      granted: true,
      canAskAgain: true,
      status: "granted",
    })),
    getDevicePushTokenAsync: vi.fn(async () => ({ type: "ios", data: "apns-token" })),
  };
  await inspectPush(api, false);
  expect(api.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(api.getDevicePushTokenAsync).not.toHaveBeenCalled();
  expect((await inspectPush(api, true)).token).toBe("apns-token");
  permission.canAskAgain = false;
  await inspectPush(api, true);
  expect(api.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  permission.granted = true;
  api.getDevicePushTokenAsync = vi.fn(async () => {
    throw new Error("Simulator");
  });
  expect((await inspectPush(api, false)).permission.granted).toBe(true);
});

it("does not publish a sample setting when persistence fails", async () => {
  const fake = new FakeTransport({
    onSettings: async () => {
      throw new Error("Storage unavailable");
    },
  });
  const client = createClient(fake);
  await vi.waitFor(() => expect(client.getState().status).toBe("online"));
  const before = client.getState().snapshot;
  await expect(
    client
      .getState()
      .call("settings.set", { key: preferenceKey("this-iphone", "pushTitles"), value: true }),
  ).rejects.toThrow("Storage unavailable");
  expect(client.getState().snapshot).toBe(before);
  client.stop();
});
