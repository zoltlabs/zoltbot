// Metro setup for the workspace.
// 1. Workspace packages import TypeScript siblings with ".js" endings (NodeNext style). Metro looks
//    for the exact file, so retry those imports without the ending and let it find the ".ts".
// 2. TypeBox's ESM build re-exports in circles with `export *`, which Metro's module wrapper
//    cannot order, so TypeBox loads its CommonJS build instead.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const linkRoot = path.resolve(__dirname, "../../packages/link");
const noiseSodium = path.join(linkRoot, "src/noise-sodium.ts");
const portableBytes = path.join(
  path.dirname(require.resolve("b4a/package", { paths: [linkRoot] })),
  "browser.js",
);

const config = getDefaultConfig(__dirname);
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const next = resolve ?? context.resolveRequest;
  // noise-handshake uses the same published state machine on Node and Hermes. Only the
  // primitive provider changes; neither native sodium nor optional b4a native bindings ship.
  if (moduleName === "sodium-universal") return { type: "sourceFile", filePath: noiseSodium };
  if (moduleName === "b4a") return { type: "sourceFile", filePath: portableBytes };
  if (moduleName.startsWith("@sinclair/typebox")) {
    const conditions = context.unstable_conditionNames.filter((name) => name !== "import");
    return next(
      { ...context, unstable_conditionNames: [...new Set(["require", ...conditions])] },
      moduleName,
      platform,
    );
  }
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return next(context, moduleName.slice(0, -3), platform);
    } catch {}
  }
  return next(context, moduleName, platform);
};
module.exports = config;
