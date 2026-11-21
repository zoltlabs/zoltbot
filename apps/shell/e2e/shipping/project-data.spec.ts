import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ProjectDatabases } from "../../../../packages/daemon/src/project-data/databases";
import { compareFixture } from "../../../../tools/fakes/src/compare-fixture";
import { axeViolations, COLOR_SCHEMES, settleColorScheme, shellSession } from "../harness";

const project = (id: string, name: string) => ({
  value: {
    id,
    name,
    goal: "",
    instructions: "",
    constraints: "",
    roots: [],
    hierarchyDepth: 1,
    tags: [],
    requireCodeReview: false,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: new Date().toISOString(),
  },
});

/** M8: the Data page shows the tables a project's agents made, read-only, with CSV export. */
test("The Data page lists a project's tables, shows rows and exports CSV", async ({ page }) => {
  const fixture = await compareFixture();
  const shell = await shellSession(fixture.daemon);
  // What the project's agents would have written with project_db_exec.
  const databases = new ProjectDatabases(path.join(fixture.daemon.dataDir, "project-data"));
  try {
    await shell.rpc.call("project.create", project("sales", "Sales"), "create-sales");
    await shell.rpc.call("project.create", project("web", "Web"), "create-web");
    await databases.exec("sales", "CREATE TABLE leads (name TEXT, stage TEXT, score INTEGER)");
    await databases.exec(
      "sales",
      "INSERT INTO leads VALUES ('Acme', 'Contacted', 3), ('Globex', 'Won, signed', 5)",
    );
    await databases.exec("sales", "CREATE TABLE invoices (number TEXT)");
    await shell.open(page);
    const sidebar = page.getByRole("complementary", { name: "Bot navigation" });
    await sidebar.getByRole("button", { name: "Data", exact: true }).click();
    const data = page.getByRole("main", { name: "Data" });
    await expect(data.getByRole("heading", { name: "Data" })).toBeFocused();

    // Projects are listed by name; Sales comes first.
    const tables = data.getByRole("navigation", { name: "Tables" });
    await expect(tables.getByRole("button")).toHaveText(["invoices0 rows", "leads2 rows"]);
    await tables.getByRole("button", { name: /leads/ }).click();
    const grid = data.getByRole("region", { name: "leads" });
    await expect(grid.getByRole("columnheader")).toHaveText(["name", "stage", "score"]);
    await expect(grid.getByRole("row").nth(2)).toContainText("Globex");
    await expect(data.getByText("1–2 of 2")).toBeVisible();
    for (const scheme of COLOR_SCHEMES) {
      await settleColorScheme(page, scheme);
      expect(await axeViolations(page)).toEqual([]);
    }

    const download = page.waitForEvent("download");
    await data.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("leads.csv");
    expect(readFileSync(await file.path(), "utf8")).toBe(
      'name,stage,score\r\nAcme,Contacted,3\r\nGlobex,"Won, signed",5\r\n',
    );

    // Another project with no database yet.
    await data.getByRole("button", { name: /^Project/ }).click();
    await page.getByRole("option", { name: "Web" }).click();
    await expect(data.getByText("No tables yet. Agents create them as they work.")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    expect(shell.errors).toEqual([]);
  } finally {
    await shell.close();
    await fixture.close();
  }
});
