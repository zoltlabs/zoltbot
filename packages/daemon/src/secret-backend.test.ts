import path from "node:path";
import { describe, expect, it } from "vitest";
import { secretBackend } from "./secret-backend.js";

describe("secret backend (D10)", () => {
  const base = { dataDir: "/srv/zoltbot/data", cwd: "/srv/zoltbot" };
  it("uses the keychain on a Mac, sealed files on Linux, and nothing elsewhere", () => {
    expect(secretBackend({ ...base, platform: "darwin", env: {} })).toBeTypeOf("function");
    expect(secretBackend({ ...base, platform: "linux", env: {} })).toBeTypeOf("function");
    expect(secretBackend({ ...base, platform: "win32", env: {} })).toBeUndefined();
    // A named folder turns the file store on anywhere, for a self-hosted daemon on a Mac.
    expect(
      secretBackend({
        ...base,
        platform: "win32",
        env: { ZOLTBOT_SECRETS_DIR: path.resolve("x") },
      }),
    ).toBeTypeOf("function");
  });
});
