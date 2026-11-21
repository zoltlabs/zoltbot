import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentTemplateSchema, parse } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { agentTemplate, agentTemplates } from "./index.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
// Sentence-case names, ids that match the file name.
const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

describe("agent templates", () => {
  it("lists every template file once, in gallery order", () => {
    expect(agentTemplates).toHaveLength(16);
    expect(new Set(agentTemplates.map((row) => row.id)).size).toBe(16);
    expect(files.map((name) => name.replace(/\.json$/, "")).sort()).toEqual(
      agentTemplates.map((row) => row.id).sort(),
    );
    expect(agentTemplate("code-reviewer")?.name).toBe("Code reviewer");
    expect(agentTemplate("missing")).toBeUndefined();
  });

  it.each(files)("%s matches the schema and the rules", (name) => {
    const row = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
    expect(() => parse(AgentTemplateSchema, row)).not.toThrow();
    expect(`${row.id}.json`).toBe(name);
    expect(row.instructions.split(/\s+/).length).toBeLessThan(300);
    // Connection catalog ids (broker services and connection recipes).
    for (const id of row.connections)
      expect([
        "github",
        "gmail",
        "google_drive",
        "google_docs",
        "linear",
        "sentry",
        "posthog",
      ]).toContain(id);
  });
});
