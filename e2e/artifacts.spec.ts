import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { launch, showConversationDetails, showWorkspaceTree } from "./desktop.js";
import { rpc } from "./rpc.js";

for (const surface of ["development", "packaged"] as const)
  test(`isolates the artifact panel from network, navigation, app credentials and SVG scripts (${surface})`, async () => {
    if (surface === "packaged") execFileSync("pnpm", ["build:ui"], { stdio: "pipe" });
    const requests: string[] = [];
    const sink = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.end("fixture");
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const address = sink.address();
    if (!address || typeof address === "string") throw Error("fixture_sink_missing");
    const prior = process.env.ZOLTBOT_ARTIFACT_SINK;
    const sinkUrl = `http://127.0.0.1:${address.port}`;
    process.env.ZOLTBOT_ARTIFACT_SINK = sinkUrl;
    const fixture = await launch(
      "artifacts",
      undefined,
      surface === "packaged" ? { uiUrl: "zoltbot://desktop/" } : {},
    );
    const { page } = fixture;
    try {
      // This UI-only seed runs after daemon listen; wait for it, then take a fresh snapshot.
      await expect
        .poll(
          async () => ((await rpc(page, "artifact.list", {})) as { items: unknown[] }).items.length,
        )
        .toBe(6);
      await page.evaluate(() => localStorage.setItem("zoltbot.inline-artifacts", "disabled"));
      await page.reload();
      await page.getByRole("button", { name: /Chat verification/ }).click();
      await showConversationDetails(page);
      await page.getByRole("button", { name: "Open Hostile fixture", exact: true }).click();
      const frame = page.frameLocator('iframe[title="Hostile fixture, version 1"]');
      await expect(
        frame.getByRole("heading", { name: "Hostile fixture", exact: true }),
      ).toBeVisible();
      const child = page.frames().find((f) => f.url().startsWith("zoltbot-artifact:"));
      if (!child) throw Error("artifact_frame_missing");
      await expect
        .poll(() =>
          child.evaluate(() => (window as unknown as { fixtureChecks?: unknown }).fixtureChecks),
        )
        .toMatchObject({
          parent: "denied",
          storage: "denied",
          sessionStorage: "denied",
          indexedDB: "denied",
        });
      expect(
        await child.evaluate(() => ({
          opener: window.opener,
          bridge: typeof (window as unknown as { zoltDesktop?: unknown }).zoltDesktop,
          origin: self.origin,
        })),
      ).toEqual({ opener: null, bridge: "undefined", origin: "null" });
      expect(requests).toEqual([]);
      expect(page.url()).toContain("#chat/h");
      expect(fixture.app.windows()).toHaveLength(1);
      expect(
        await page.evaluate(() => (window as unknown as { fixtureUnsafe?: boolean }).fixtureUnsafe),
      ).toBeUndefined();
      // A compromised frame cannot fetch the daemon or another version, or navigate to an exfiltration URL.
      await child.evaluate((sinkUrl) => {
        location.href = `${sinkUrl}/navigation`;
      }, sinkUrl);
      expect(page.url()).toContain("#chat/h");
      await page.screenshot({ path: "output/playwright/artifact-hostile-dark.png" });
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      await page.getByRole("button", { name: "Open SVG fixture", exact: true }).click();
      await expect
        .poll(() => page.frames().some((f) => f.url().startsWith("zoltbot-artifact:")))
        .toBe(true);
      const svg = page.frames().find((f) => f.url().startsWith("zoltbot-artifact:"));
      await expect(page.locator('iframe[title="SVG fixture, version 1"]')).toBeVisible();
      await expect
        .poll(() =>
          svg?.evaluate(
            () => typeof (window as unknown as { svgScriptRan?: boolean }).svgScriptRan,
          ),
        )
        .toBe("undefined");
      expect(requests).toEqual([]);
      await expect(
        page.frameLocator('iframe[title="SVG fixture, version 1"]').locator("svg"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      await page.getByRole("button", { name: "Open Bundle fixture", exact: true }).click();
      const bundle = page.frameLocator('iframe[title="Bundle fixture, version 1"]');
      await expect(bundle.locator("output")).toHaveText("Bundle data loaded");
      await expect(bundle.getByRole("heading")).toHaveCSS("color", "rgb(10, 20, 30)");
      await page.screenshot({ path: "output/playwright/artifact-bundle-dark.png" });
      expect(requests).toEqual([]);
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      await page.getByRole("button", { name: "Open Document fixture", exact: true }).click();
      const documentFrame = page.frameLocator('iframe[title="Document fixture, version 1"]');
      await expect(
        documentFrame.getByRole("heading", { name: "Document fixture", exact: true }),
      ).toBeVisible();
      await expect(documentFrame.locator("strong")).toHaveText("Readable");
      await expect(documentFrame.locator("img,script")).toHaveCount(0);
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      await page.getByRole("button", { name: "Open Image fixture", exact: true }).click();
      const image = page.frameLocator('iframe[title="Image fixture, version 1"]').locator("img");
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBe(1280);
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      await page.getByRole("button", { name: "Open Kit fixture", exact: true }).click();
      const kit = page.frameLocator('iframe[title="Kit fixture, version 1"]');
      await expect(kit.locator("canvas")).toBeVisible();
      await expect(kit.getByRole("heading", { name: "Explore the trend", exact: true })).toHaveCSS(
        "font-family",
        /system-ui/,
      );
      await kit.getByLabel("Scale", { exact: false }).focus();
      await kit.getByLabel("Scale", { exact: false }).press("ArrowRight");
      await expect(kit.locator("#total")).toHaveText("120");
      await page.screenshot({ path: "output/playwright/artifact-kit-dark.png" });
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
      const listed = (await rpc(page, "artifact.list", {})) as {
        items: { id: string; key: string }[];
      };
      const linked = listed.items.find((item) => item.key === "bundle");
      if (!linked) throw Error("artifact_reference_missing");
      const target = new URL(page.url());
      target.hash = `artifact/${linked.id}`;
      await page.goto(target.href);
      await expect(
        page.frameLocator('iframe[title="Bundle fixture, version 1"]').locator("output"),
      ).toHaveText("Bundle data loaded");
      expect(requests).toEqual([]);
      expect((await new AxeBuilder({ page }).setLegacyMode().analyze()).violations).toEqual([]);
    } finally {
      await fixture.cleanup();
      await new Promise<void>((resolve) => sink.close(() => resolve()));
      if (prior === undefined) delete process.env.ZOLTBOT_ARTIFACT_SINK;
      else process.env.ZOLTBOT_ARTIFACT_SINK = prior;
    }
  });

test("renders actual live-provider artifact versions from the local canary store", async () => {
  const directory = process.env.ZOLTBOT_ARTIFACT_CANARY_DIR;
  test.skip(!directory, "Explicit live product canary store required");
  const fixture = await launch(false, directory);
  const { page } = fixture;
  try {
    await page.evaluate(() => localStorage.setItem("zoltbot.inline-artifacts", "disabled"));
    for (const provider of ["claude", "codex"]) {
      const url = new URL(page.url());
      url.hash = `chat/artifact-${provider}`;
      await page.goto(url.href);
      await showConversationDetails(page);
      await page.getByRole("button", { name: "Open Local canary", exact: true }).click();
      const started = performance.now();
      await expect(
        page
          .frameLocator('iframe[title="Local canary, version 2"]')
          .getByRole("heading", { name: "Local canary version 2", exact: true }),
      ).toBeVisible();
      const renderMs = performance.now() - started;
      await page.getByLabel("Artifact version", { exact: true }).selectOption({ label: "v1" });
      await expect(
        page
          .frameLocator('iframe[title="Local canary, version 1"]')
          .getByRole("heading", { name: "Local canary version 1", exact: true }),
      ).toBeVisible();
      await page.screenshot({ path: `output/playwright/artifact-live-${provider}-v1.png` });
      console.log(JSON.stringify({ provider, renderMs, versions: 2, liveFrames: 1 }));
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
    }
  } finally {
    await fixture.cleanup();
  }
});

test("keeps an open historical version pinned through production fake-provider turns", async () => {
  test.setTimeout(45000);
  mkdirSync(".cache/e2e", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/e2e/artifact-host-"));
  execFileSync(
    process.execPath,
    ["--import", "tsx", "tools/fakes/src/seed-native-desktop.ts", directory],
    { env: { ...process.env, TSX_DISABLE_CACHE: "1" } },
  );
  const fixture = await launch(false, directory),
    { page } = fixture;
  try {
    await page.evaluate(() => localStorage.setItem("zoltbot.inline-artifacts", "disabled"));
    await page.reload();
    // Quick Chat finds the coding tools installed on this machine, and a workspace chat routes
    // each request through the first ready one. Remove them so the turn reaches the seeded
    // fake provider instead of a real model.
    const quick = (await rpc(page, "quickConnection.list", {})) as { items: { id: string }[] };
    for (const item of quick.items)
      await rpc(
        page,
        "quickConnection.remove",
        { id: item.id, confirmed: true },
        crypto.randomUUID(),
      );
    // The seeded providers share a project: the same key intentionally refers to one artifact.
    for (const [provider, title] of [["Claude", "Claude workflow"]] as const) {
      await showWorkspaceTree(page);
      await page.getByRole("button", { name: title, exact: true }).click();
      await showConversationDetails(page);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const editor = page.getByRole("textbox", { name: `Message ${provider}`, exact: true });
      await editor.fill("artifact_page");
      await editor.press("Enter");
      const card = page.getByRole("article", { name: "Provider page", exact: true });
      await expect(card).toHaveCount(1);
      await card.evaluate((node) => {
        (node as HTMLElement).dataset.fixtureIdentity = "original";
      });
      await card.getByRole("button", { name: "Open Provider page", exact: true }).click();
      await expect(
        page
          .frameLocator('iframe[title="Provider page, version 1"]')
          .getByRole("heading", { name: "Artifact version one" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await editor.fill("artifact_page_v2");
      await editor.press("Enter");
      await expect(
        page.getByRole("button", { name: "View current version", exact: true }),
      ).toBeVisible();
      await expect(page.locator('iframe[title="Provider page, version 1"]')).toBeVisible();
      await page.getByRole("button", { name: "View current version", exact: true }).click();
      await expect(
        page
          .frameLocator('iframe[title="Provider page, version 2"]')
          .getByRole("heading", { name: "Artifact version two" }),
      ).toBeVisible();
      const retained = page.locator('.artifact-card[aria-label="Provider page"]');
      await expect(retained).toHaveCount(1);
      await expect(retained).toHaveAttribute("data-fixture-identity", "original");
      await page.getByRole("button", { name: "Close artifact", exact: true }).click();
    }
  } finally {
    await fixture.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const surface of ["development", "packaged"] as const)
  test(`bounds inline previews and recovers from a looping artifact (${surface})`, async () => {
    if (surface === "packaged") execFileSync("pnpm", ["build:ui"], { stdio: "pipe" });
    const fixture = await launch(
      "artifacts",
      undefined,
      surface === "packaged" ? { uiUrl: "zoltbot://desktop/" } : {},
    );
    const { page } = fixture;
    try {
      await expect
        .poll(
          async () => ((await rpc(page, "artifact.list", {})) as { items: unknown[] }).items.length,
        )
        .toBe(6);
      await page.reload();
      await page.getByRole("button", { name: /Chat verification/ }).click();
      await showConversationDetails(page);
      const preference = page.getByRole("checkbox", { name: "Interactive previews in chat" });
      await expect(preference).toBeChecked();
      await expect.poll(() => page.locator(".artifact-inline iframe").count()).toBeGreaterThan(0);
      expect(await page.locator(".artifact-inline iframe").count()).toBeLessThanOrEqual(2);
      await expect
        .poll(() => page.frames().some((frame) => frame.url().startsWith("zoltbot-artifact:")))
        .toBe(true);
      const child = page.frames().find((frame) => frame.url().startsWith("zoltbot-artifact:"));
      if (!child) throw Error("inline_frame_missing");
      await child.evaluate(() => {
        setTimeout(() => {
          while (true) {
            /* hostile fixture */
          }
        }, 100);
      });
      // Allow the hostile timer to enter its loop before testing host recovery.
      await page.waitForTimeout(300);
      await preference.uncheck();
      await expect(page.locator(".artifact-inline iframe")).toHaveCount(0);
      await expect(preference).not.toBeChecked();
      await page.screenshot({ path: `output/playwright/visualize-recovered-${surface}.png` });
      await page.reload();
      await showConversationDetails(page);
      await expect(
        page.getByRole("checkbox", { name: "Interactive previews in chat" }),
      ).not.toBeChecked();
      await expect(page.locator(".artifact-inline iframe")).toHaveCount(0);
      await page.getByRole("button", { name: "Expand Bundle fixture", exact: true }).click();
      const expanded = page.locator(".artifact-inline-panel");
      await expect(expanded.locator("iframe")).toHaveCount(1);
      await expect(expanded.frameLocator("iframe").locator("output")).toHaveText(
        "Bundle data loaded",
      );
      await expanded.getByRole("button", { name: "Revise this version", exact: true }).click();
      await expect(expanded).toHaveCount(0);
      await expect(page.locator(".artifact-revision-chip")).toContainText("Revise Bundle fixture");
      await page.getByRole("button", { name: "Remove artifact target", exact: true }).click();
      await expect(page.locator(".artifact-revision-chip")).toHaveCount(0);
    } finally {
      await fixture.cleanup();
    }
  });
