import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { folderPicker } from "./folder-picker.js";

it("returns only explicitly selected canonical directories and treats cancellation as no selection", async () => {
  await mkdir(".cache/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".cache/tests/folders-"));
  try {
    await mkdir(path.join(root, "code"));
    const choose = folderPicker(async () => ({
      canceled: false,
      filePaths: [path.join(root, "code"), path.join(root, "code")],
    }));
    expect(await choose()).toEqual([path.join(root, "code")]);
    expect(await folderPicker(async () => ({ canceled: true, filePaths: [root] }))()).toEqual([]);
    await writeFile(path.join(root, "file"), "synthetic");
    await expect(
      folderPicker(async () => ({ canceled: false, filePaths: [path.join(root, "file")] }))(),
    ).rejects.toThrow("invalid_folder_selection");
    await expect(
      folderPicker(async () => ({ canceled: false, filePaths: ["relative"] }))(),
    ).rejects.toThrow("invalid_folder_selection");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("owns one native dialog at a time and releases it after failure", async () => {
  let release: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined;
  let calls = 0;
  const pick = folderPicker(() => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const first = pick(),
    second = pick();
  expect(calls).toBe(1);
  release?.({ canceled: true, filePaths: [] });
  expect(await first).toEqual([]);
  expect(await second).toEqual([]);
  const third = pick();
  expect(calls).toBe(2);
  release?.({ canceled: true, filePaths: [] });
  await third;
  let failures = 0;
  const failing = folderPicker(async () => {
    failures++;
    throw new Error("native-dialog-failed");
  });
  await expect(failing()).rejects.toThrow("folder_picker_failed");
  await expect(failing()).rejects.toThrow("folder_picker_failed");
  expect(failures).toBe(2);
});
