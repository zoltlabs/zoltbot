// D8: what a desktop build ships on each system. package-desktop.mjs builds the Mac app from this;
// Windows and Linux builds read the same table once they run on their own build machines.

/** The systems Zoltbot's desktop app targets, as Node names them. */
export const DESKTOP_PLATFORMS = ["darwin", "win32", "linux"];

const NODE_SYSTEM = { darwin: "darwin", win32: "win", linux: "linux" };

/**
 * The files a build for `platform` and `cpu` downloads and makes.
 * `node` is the Node version, `sqlite` the better-sqlite3 version and `abi` Node's module ABI.
 */
export function desktopTarget(platform, cpu, { node, sqlite, abi }) {
  if (!DESKTOP_PLATFORMS.includes(platform)) throw new Error(`unsupported_platform: ${platform}`);
  if (cpu !== "arm64" && cpu !== "x64") throw new Error(`unsupported_cpu: ${cpu}`);
  const folder = `node-v${node}-${NODE_SYSTEM[platform]}-${cpu}`;
  const nodeArchive =
    platform === "win32"
      ? `${folder}.zip`
      : platform === "linux"
        ? `${folder}.tar.xz`
        : `${folder}.tar.gz`;
  return {
    nodeArchive,
    /** The Node binary inside the archive. */
    nodeMember: platform === "win32" ? `${folder}/node.exe` : `${folder}/bin/node`,
    sqliteArchive: `better-sqlite3-v${sqlite}-node-v${abi}-${platform}-${cpu}.tar.gz`,
    /** Native prebuilds kept from dependencies; the others are removed. */
    prebuildPrefix: `${platform}-`,
    /** The keychain and speech helpers are Swift, built only on a Mac. */
    nativeHelpers: platform === "darwin",
    installers:
      platform === "darwin"
        ? ["dmg", "zip"]
        : platform === "win32"
          ? ["nsis"]
          : ["AppImage", "deb"],
    /** The feed electron-updater reads; electron-builder names it per system. */
    updateFeed:
      platform === "darwin"
        ? "latest-mac.yml"
        : platform === "win32"
          ? "latest.yml"
          : "latest-linux.yml",
  };
}
