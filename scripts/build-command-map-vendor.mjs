// Rebuilds packages/views/command-map/vendor/three-<version>.bundle.min.js.
//
// A view's own code loads as classic scripts, so three.js and the add-ons the map uses are
// bundled into one classic script that defines `window.THREE`. The view never loads this from
// the network; the bundle is committed. Run `node scripts/build-command-map-vendor.mjs` only
// when changing the pinned version or the add-on list below.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const version = "0.187.0";
const tarball = `https://registry.npmjs.org/three/-/three-${version}.tgz`;
const integrity =
  "sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==";
const addons = {
  EffectComposer: "postprocessing/EffectComposer.js",
  RenderPass: "postprocessing/RenderPass.js",
  ShaderPass: "postprocessing/ShaderPass.js",
  UnrealBloomPass: "postprocessing/UnrealBloomPass.js",
  GTAOPass: "postprocessing/GTAOPass.js",
  OutputPass: "postprocessing/OutputPass.js",
  RoundedBoxGeometry: "geometries/RoundedBoxGeometry.js",
};
const vendor = fileURLToPath(new URL("../packages/views/command-map/vendor/", import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), "command-map-three-"));
try {
  const response = await fetch(tarball);
  if (!response.ok) throw Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (digest !== integrity) throw Error(`Integrity mismatch for three ${version}`);
  const archive = path.join(work, "three.tgz"),
    library = path.join(work, "node_modules/three");
  writeFileSync(archive, bytes);
  mkdirSync(library, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", library, "--strip-components=1"]);
  const entry = path.join(work, "entry.mjs");
  writeFileSync(
    entry,
    [
      'export * from "three";',
      ...Object.entries(addons).map(
        ([name, file]) => `export { ${name} } from "three/addons/${file}";`,
      ),
      'export { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";',
    ].join("\n"),
  );
  const output = path.join(vendor, `three-${version}.bundle.min.js`);
  await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    format: "iife",
    globalName: "THREE",
    minify: true,
    legalComments: "none",
    target: "es2022",
    // Shader sources are template literals full of newlines. Writing them as plain strings keeps
    // the bundle to a few long lines, like any other minified file.
    supported: { "template-literal": false },
    banner: {
      js: `/* three.js ${version} with post-processing add-ons. MIT license: see LICENSE.txt. Built by scripts/build-command-map-vendor.mjs. */`,
    },
  });
  copyFileSync(path.join(library, "LICENSE"), path.join(vendor, "LICENSE.txt"));
  console.log(`${path.basename(output)}: ${statSync(output).size} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
