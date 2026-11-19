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
    /** Opens the built renderer in `page` and records uncaught page errors in `errors`. */
    async open(page: Page) {
      page.on("pageerror", (error) => errors.push(error.message));
      await openShell(page, service);
    },
    async close() {
      rpc.stop();
      await service.stop();
    },
  };
}

/**
 * Axe rules the shell fails today, kept visible here instead of disabled: each one is reported
 * in NOT-PORTED.md. A violation of any other rule fails the test.
 */
export const KNOWN_SHELL_A11Y = new Set(["color-contrast", "region"]);

/** Runs axe on the page and returns each violation of a rule outside `known`, with its nodes. */
export async function axeViolations(
  page: Page,
  known: ReadonlySet<string> = KNOWN_SHELL_A11Y,
): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  const lines = result.violations.map(
    (violation) =>
      `${violation.id}: ${violation.nodes
        .map((node) => `${node.target.join(" ")} (${node.any.map((c) => c.message).join("; ")})`)
        .join(", ")}`,
  );
  if (process.env.ZOLTBOT_AXE_LOG) for (const line of lines) console.log(`axe ${line}`);
  return lines.filter((line) => !known.has(line.slice(0, line.indexOf(":"))));
}
