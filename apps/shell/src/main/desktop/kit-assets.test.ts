import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { artifactKitRoot, desktopKitAsset } from "./kit-assets";

const repo = resolve(__dirname, "../../../../..");
const chart = "packages/artifact-kit/v1/chart-4.5.1.umd.js";
let folder: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

it("serves the chart library from a packaged app folder, not the checkout", () => {
  folder = mkdtempSync(join(tmpdir(), "zoltbot-app-"));
  const app = join(folder, "Zoltbot.app/Contents/Resources/app");
  cpSync(join(repo, "packages/artifact-kit/v1"), join(app, "packages/artifact-kit/v1"), {
    recursive: true,
  });
  vi.stubEnv("ZOLTBOT_REPO_ROOT", join(folder, "elsewhere"));
  expect(artifactKitRoot(true, app)).toBe(app);
  const asset = desktopKitAsset(true, app)("chart.js");
  expect(asset?.mime).toBe("text/javascript");
  expect(Buffer.compare(asset?.bytes ?? Buffer.alloc(0), readFileSync(join(repo, chart)))).toBe(0);
});

it("reads the kit from the checkout in development", () => {
  vi.stubEnv("ZOLTBOT_REPO_ROOT", "");
  delete process.env.ZOLTBOT_REPO_ROOT;
  expect(artifactKitRoot(false, join(repo, "apps/shell"))).toBe(repo);
  expect(desktopKitAsset(false, join(repo, "apps/shell"))("chart.js")?.bytes.length).toBe(208522);
});

it("stages the chart library in the packaged app", () => {
  const script = readFileSync(join(repo, "scripts/package-desktop.mjs"), "utf8");
  expect(script).toContain('"packages/artifact-kit/v1",');
  expect(script).toContain(chart);
});
