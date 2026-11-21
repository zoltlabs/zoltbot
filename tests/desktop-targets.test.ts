import { describe, expect, it } from "vitest";
import { DESKTOP_PLATFORMS, desktopTarget } from "../scripts/desktop-targets.mjs";

const versions = { node: "24.1.0", sqlite: "12.2.0", abi: "137" };

describe("desktop targets (D8)", () => {
  it("names the Mac files the packaging script has always downloaded", () => {
    expect(desktopTarget("darwin", "arm64", versions)).toEqual({
      nodeArchive: "node-v24.1.0-darwin-arm64.tar.gz",
      nodeMember: "node-v24.1.0-darwin-arm64/bin/node",
      sqliteArchive: "better-sqlite3-v12.2.0-node-v137-darwin-arm64.tar.gz",
      prebuildPrefix: "darwin-",
      nativeHelpers: true,
      installers: ["dmg", "zip"],
      updateFeed: "latest-mac.yml",
    });
  });

  it("uses Node's own names on Windows and Linux", () => {
    expect(desktopTarget("win32", "x64", versions)).toMatchObject({
      nodeArchive: "node-v24.1.0-win-x64.zip",
      nodeMember: "node-v24.1.0-win-x64/node.exe",
      sqliteArchive: "better-sqlite3-v12.2.0-node-v137-win32-x64.tar.gz",
      nativeHelpers: false,
      installers: ["nsis"],
      updateFeed: "latest.yml",
    });
    expect(desktopTarget("linux", "arm64", versions)).toMatchObject({
      nodeArchive: "node-v24.1.0-linux-arm64.tar.xz",
      nodeMember: "node-v24.1.0-linux-arm64/bin/node",
      prebuildPrefix: "linux-",
      installers: ["AppImage", "deb"],
      updateFeed: "latest-linux.yml",
    });
  });

  it("refuses a system or processor it doesn't build for", () => {
    expect(DESKTOP_PLATFORMS).toEqual(["darwin", "win32", "linux"]);
    expect(() => desktopTarget("freebsd", "x64", versions)).toThrow("unsupported_platform");
    expect(() => desktopTarget("linux", "ia32", versions)).toThrow("unsupported_cpu");
  });
});
