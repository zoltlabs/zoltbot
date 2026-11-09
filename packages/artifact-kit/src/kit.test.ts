import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { artifactKitAsset, artifactTemplate } from "./index.js";

it("keeps every starter within the host result cap and resolves a pinned offline kit after relocation", async () => {
  for (const name of [
    "comparison",
    "proposal",
    "metrics",
    "onboarding",
    "tool",
    "repository-activity",
    "system-flow",
    "ui-variants",
  ]) {
    const template = artifactTemplate(name);
    expect(JSON.stringify(template).length).toBeLessThan(4000);
    expect(template.files[0]?.text).toContain("kit/v1/style.css");
    expect(template.files[0]?.text).not.toMatch(/https?:\/\//);
  }
  await mkdir(".cache/tests", { recursive: true });
  const root = await mkdtemp(path.resolve(".cache/tests/kit-copy-"));
  try {
    await cp("packages/artifact-kit/v1", path.join(root, "packages/artifact-kit/v1"), {
      recursive: true,
    });
    expect(artifactKitAsset(root, "chart.js")?.bytes.length).toBe(208522);
    expect(artifactKitAsset(root, "style.css")?.mime).toBe("text/css");
    expect(artifactKitAsset(root, "../outside")).toBeUndefined();
    expect(artifactKitAsset(root, "__proto__")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
