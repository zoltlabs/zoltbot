import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCredentials, syntheticCredentials } from "@zoltbot/cloud-contracts";
import { expect, it } from "vitest";
import { cloudAccount } from "../../../apps/desktop/src/cloud-account.js";
import { createCloudFake } from "./cloud.js";

it("uses the public credential contract without a database or provider credentials", async () => {
  const server = createCloudFake();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account`;
  try {
    expect((await fetch(`${origin}/me`)).status).toBe(401);
    const credentials = parseCredentials(
      await (
        await fetch(`${origin}/session/refresh`, {
          method: "POST",
          headers: { authorization: `Refresh ${syntheticCredentials.refreshToken}` },
        })
      ).json(),
    );
    const headers = { authorization: `Bearer ${credentials.accessToken}` };
    expect((await (await fetch(`${origin}/me`, { headers })).json()).user.email).toBe(
      "user@example.test",
    );
    await fetch(`${origin}/logout`, { method: "POST", headers });
    expect((await fetch(`${origin}/me`, { headers })).status).toBe(401);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("supports the actual desktop handoff, artifact upload, sharing and session revocation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zolt-public-cloud-"));
  const server = createCloudFake();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const blob = Buffer.from("<!doctype html><h1>Synthetic artifact</h1>");
  const manifest = Buffer.from(
    JSON.stringify({
      version: 1,
      entry: "index.html",
      screens: [],
      files: [{ path: "index.html", hash: sha(blob), bytes: blob.length, mime: "text/html" }],
    }),
  );
  let stored: unknown;
  const controller = cloudAccount({
    origin,
    referenceFile: path.join(directory, "reference"),
    deviceName: "Synthetic desktop",
    async openBrowser(url) {
      await (await fetch(url)).text();
    },
    async readArtifact(kind) {
      return kind === "manifest" ? manifest : blob;
    },
    secrets: {
      async put(value) {
        stored = value;
        return { reference: "keychain:synthetic" };
      },
      async read() {
        return stored;
      },
      async replace(_reference, value) {
        stored = value;
      },
      async remove() {
        stored = undefined;
      },
    },
  });
  try {
    expect((await controller.status()).signedIn).toBe(false);
    const status = await controller.signIn();
    expect(status.signedIn).toBe(true);
    expect(JSON.stringify(status)).not.toContain(syntheticCredentials.accessToken);
    const artifact = await controller.uploadArtifact(
      sha(manifest),
      "Synthetic design",
      "22222222-2222-4222-8222-222222222222",
      true,
    );
    expect(artifact.visibility).toBe("private");
    expect(
      (
        await controller.uploadArtifact(
          sha(manifest),
          "Synthetic design",
          "22222222-2222-4222-8222-222222222222",
          true,
        )
      ).id,
    ).toBe(artifact.id);
    expect(await controller.findArtifact(sha(manifest), "Synthetic design")).toMatchObject({
      id: artifact.id,
    });
    expect(
      await controller.setArtifactVisibility({
        id: artifact.id,
        hash: sha(manifest),
        title: "Synthetic design",
        visibility: "public",
        confirm: true,
      }),
    ).toMatchObject({ visibility: "public", url: `${origin}/s/${artifact.id}` });
    expect((await controller.revoke("11111111-1111-4111-8111-111111111111")).signedIn).toBe(false);
  } finally {
    controller.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
