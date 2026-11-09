import { expect, it } from "vitest";
import { artifactFixture } from "./test-fixture.js";
import { artifactTools } from "./tools.js";

it("recovers exact old source after saves, pages escaped Unicode within the result cap, and rejects foreign cursors", async () => {
  const f = await artifactFixture();
  try {
    const text = `<!doctype html><p>${'🦊"\\\n'.repeat(1600)}</p>`;
    const first = await f.save(text);
    await f.save("<h1>Replacement</h1>");
    const read = (cursor?: string, versionId = first.versionId) =>
      artifactTools(f.context).call({
        actor: f.actor,
        idempotencyKey: "read",
        arguments: { action: "read", id: first.artifactId, versionId, path: "index.html", cursor },
      }) as Promise<{ text: string; cursor: string | null }>;
    let cursor: string | undefined;
    let recovered = "";
    do {
      const result = await read(cursor);
      expect(JSON.stringify(result).length).toBeLessThan(4000);
      recovered += result.text;
      cursor = result.cursor ?? undefined;
    } while (cursor);
    expect(recovered).toBe(text);
    const page = await read();
    await expect(
      read(
        page.cursor ?? undefined,
        String(f.store.record("artifact", first.artifactId)?.currentVersionId),
      ),
    ).rejects.toThrow("artifact_cursor_invalid");
    await expect(read("bad:1")).rejects.toThrow("artifact_cursor_invalid");
    await expect(
      artifactTools(f.context).call({
        actor: f.actor,
        idempotencyKey: "scope",
        arguments: { action: "read", id: "other", versionId: first.versionId, path: "index.html" },
      }),
    ).rejects.toThrow("artifact_scope_denied");
  } finally {
    await f.close();
  }
});

it("does not grant exact source access to frozen legacy bindings or return newly private text", async () => {
  const f = await artifactFixture();
  try {
    const first = await f.save("<p>private later</p>");
    const call = () =>
      artifactTools(f.context).call({
        actor: f.actor,
        idempotencyKey: "read",
        arguments: {
          action: "read",
          id: first.artifactId,
          versionId: first.versionId,
          path: "index.html",
        },
      });
    f.context.privacy.remember("private later");
    await expect(call()).rejects.toThrow();
    const { sourceRead: _, ...legacy } = f.binding;
    f.change({
      type: "update",
      kind: "settings",
      id: "runtime.configuration.session",
      changes: { value: { launchManifest: { artifact: legacy } } },
    });
    await expect(call()).rejects.toThrow("artifact_source_read_not_enabled");
  } finally {
    await f.close();
  }
});
