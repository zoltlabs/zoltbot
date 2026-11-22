import { expect, test } from "@playwright/test";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import type { CloudSetting, CloudSettingsStatus, CloudWorkspace } from "../../src/shared/cloud";
import { IPC_CHANNELS } from "../../src/shared/ipc";
import { axeViolations, shellSession } from "../harness";

test("Cloud settings are reachable, write-only, and preserve an offline Cloud project", async ({
  page,
}) => {
  const fixture = await compareFixture();
  const snapshot: CloudWorkspace = {
    owner: { kind: "cloud", orgId: "example-org", sessionId: "fixture-session" },
    name: "Personal",
    readOnly: false,
    state: {
      status: "online",
      snapshot: {
        seq: 1,
        counters: {},
        entities: {
          project: [
            {
              id: "example-project",
              name: "Cloud example",
              goal: "",
              instructions: "",
              constraints: "",
              hierarchyDepth: 1,
              tags: [],
              requireCodeReview: true,
              skipFinalGateWhenReviewed: false,
              roots: [],
              archived: false,
              cloud: { repository: "example/example", defaultBranch: "main", setupScript: "" },
              createdAt: "2026-01-14T00:00:00.000Z",
            },
          ],
        },
      },
    },
  };
  let status: CloudSettingsStatus = {
    configured: true,
    online: true,
    eligible: true,
    enabled: false,
    runTasksOnMac: false,
    macExecution: "ask",
    projects: [],
    account: {
      userId: "fixture-user",
      sessionId: "fixture-session",
      orgId: "example-org",
      orgName: "Personal",
    },
  };
  let submittedKey = false;
  const shell = await shellSession(fixture.daemon, {
    [IPC_CHANNELS.accountGetStatus]: () => ({ configured: true, signedIn: true }),
    [IPC_CHANNELS.cloudSettings]: () => status,
    [IPC_CHANNELS.cloudUpdate]: (raw) => {
      const setting = raw as CloudSetting;
      expect(setting.sessionId).toBe("fixture-session");
      if (setting.type === "enabled") status = { ...status, enabled: setting.value };
      if (setting.type === "runner") status = { ...status, runTasksOnMac: setting.value };
      return status;
    },
    [IPC_CHANNELS.cloudSaveSecret]: (raw) => {
      const input = raw as { value?: string };
      submittedKey = input.value === "synthetic-fixture-input";
    },
    [IPC_CHANNELS.cloudWorkspace]: () => snapshot,
  });
  try {
    await shell.open(page);
    await page.getByRole("button", { name: /account menu/i }).click();
    await page.getByRole("menuitem", { name: "Cloud settings" }).click();
    const settings = page.getByRole("main", { name: "Zoltbot Cloud" });
    await expect(settings.getByRole("heading", { name: "Zoltbot Cloud" })).toBeFocused();
    await settings.getByRole("checkbox", { name: "Enable Zoltbot Cloud" }).check();
    await settings.getByRole("checkbox", { name: "Run cloud tasks on this Mac" }).check();
    const field = settings.getByLabel("Anthropic API key", { exact: true });
    await field.fill("synthetic-fixture-input");
    await settings.getByRole("button", { name: "Save Anthropic API key" }).click();
    await expect.poll(() => submittedKey).toBe(true);
    await expect(field).toHaveValue("");
    expect(await axeViolations(page)).toEqual([]);

    await page.evaluate(
      (state) => {
        window.dispatchEvent(new CustomEvent("zoltbot-cloud-fixture", { detail: state }));
      },
      { ...snapshot, readOnly: true, state: { ...snapshot.state, status: "offline" } },
    );
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await expect(sidebar.getByText("This Mac", { exact: true })).toBeVisible();
    await expect(sidebar.getByRole("button", { name: "New Cloud project" })).toBeDisabled();
    await sidebar.getByRole("button", { name: "Cloud example" }).click();
    const project = page.getByRole("main", { name: "Cloud example" });
    await expect(
      project.getByText("Cloud is offline. You can read the last synced state."),
    ).toBeVisible();
    await expect(project.getByRole("button", { name: "New task" })).toBeDisabled();
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
