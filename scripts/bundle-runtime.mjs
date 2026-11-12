import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, transform } from "esbuild";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Bundle workspace code; retain installed dependencies and source-relative resource locations.
 * With `base`, sources resolve relative to the bundle as if it sat at `base`, so a packaged copy
 * of the bundle, its resources and node_modules can move to another machine.
 */
export async function bundleRuntime(
  entry,
  outfile,
  { base, metafile = false, target = "node24" } = {},
) {
  return await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target,
    metafile,
    plugins: [
      {
        name: "workspace-runtime",
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (
              builtins.has(args.path) ||
              args.kind === "entry-point" ||
              args.pluginData?.runtimeResolved
            )
              return;
            const resolved = await builder.resolve(args.path, {
              resolveDir: args.resolveDir,
              kind: args.kind,
              pluginData: { runtimeResolved: true },
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            const external = !args.path.startsWith("@zoltbot/");
            // A movable bundle names installed packages so they resolve from its own node_modules.
            return { path: base && external ? args.path : resolved.path, external };
          });
          builder.onLoad({ filter: /\.tsx?$/ }, async (args) => {
            const source = await readFile(args.path, "utf8");
            const sourceUrl = base
              ? "__zoltbotSourceUrl"
              : JSON.stringify(pathToFileURL(args.path).href);
            const banners = [];
            if (base && /import\.meta\.(url|resolve)/.test(source))
              banners.push(
                `const __zoltbotSourceUrl = new URL(${JSON.stringify(path.relative(base, args.path).split(path.sep).join("/"))}, import.meta.url).href;`,
              );
            if (source.includes("import.meta.resolve"))
              banners.push(
                `import { createRequire as __zoltbotRequire } from "node:module"; import { pathToFileURL as __zoltbotFileUrl } from "node:url"; const __zoltbotResolveResource = (specifier) => __zoltbotFileUrl(__zoltbotRequire(${sourceUrl}).resolve(specifier)).href;`,
              );
            const result = await transform(source, {
              loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
              format: "esm",
              target,
              define: {
                "import.meta.url": sourceUrl,
                ...(source.includes("import.meta.resolve")
                  ? { "import.meta.resolve": "__zoltbotResolveResource" }
                  : {}),
              },
              ...(banners.length ? { banner: banners.join(" ") } : {}),
            });
            return { contents: result.code, loader: "js", resolveDir: path.dirname(args.path) };
          });
        },
      },
    ],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Expected an entry and output path");
  await bundleRuntime(process.argv[2], process.argv[3]);
}
