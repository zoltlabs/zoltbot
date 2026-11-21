import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { DaemonClient } from "../src/zolt/daemon-client";
import { ZoltService } from "../src/zolt/zolt-service";
import { openShell } from "./bridge";

export interface DaemonAddress {
  url: string;
  token: string;
}

/**
 * Connects a `ZoltService` to a fixture daemon the way Electron main does. `rpc` is a second
 * daemon connection for steps the test performs as an agent or another client.
 */
export async function shellSession(daemon: DaemonAddress) {
  const connect = async () => ({ url: daemon.url, token: daemon.token });
  const client = new DaemonClient(connect);
  const service = new ZoltService(client, mkdtempSync(join(tmpdir(), "zoltbot-shell-e2e-")));
  await service.initialize();
  const rpc = new DaemonClient(connect);
  await rpc.start();
  const errors: string[] = [];
  return {
    service,
    rpc,
    errors,
    /**
     * Opens the built renderer in `page` and records uncaught page errors in `errors`. `path`
     * picks another page of it, such as the agent dock's.
     */
    async open(page: Page, path?: string) {
      page.on("pageerror", (error) => errors.push(error.message));
      await openShell(page, service, path);
    },
    async close() {
      rpc.stop();
      await service.stop();
    },
  };
}

/** Color schemes the shell supports; axe checks run in each. */
export const COLOR_SCHEMES = ["dark", "light"] as const;

/**
 * Runs axe on the page in each color scheme and returns every violation, with its nodes. The
 * page is left in `colorScheme` afterwards.
 */
export async function axeViolations(
  page: Page,
  colorScheme: (typeof COLOR_SCHEMES)[number] = "dark",
): Promise<string[]> {
  const lines: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await settleColorScheme(page, scheme);
    const result = await new AxeBuilder({ page }).analyze();
    for (const violation of result.violations) {
      lines.push(
        `${scheme} ${violation.id}: ${violation.nodes
          .map((node) => `${node.target.join(" ")} (${node.any.map((c) => c.message).join("; ")})`)
          .join(", ")}`,
      );
    }
  }
  await settleColorScheme(page, colorScheme);
  if (process.env.ZOLTBOT_AXE_LOG) for (const line of lines) console.log(`axe ${line}`);
  return lines;
}

/**
 * Switches the page's color scheme and waits for the color transitions it starts to end. The
 * shell's stylesheets follow data-theme on <html>, which the app sets from prefers-color-scheme
 * while the Theme setting is System; waiting for it means both themes really render.
 */
export async function settleColorScheme(
  page: Page,
  colorScheme: (typeof COLOR_SCHEMES)[number],
): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await page.waitForFunction((scheme) => {
    const { theme, themeChoice } = document.documentElement.dataset;
    // Pages without the app (kit fixtures) have no data-theme of their own, and a theme the
    // owner chose doesn't follow the system.
    return theme === undefined || theme === scheme || (themeChoice ?? "system") !== "system";
  }, colorScheme);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}
