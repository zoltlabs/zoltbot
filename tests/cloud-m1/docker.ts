import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { ExecutionTarget } from "../../packages/sandbox/src/interface.js";
import { createDockerTarget } from "../../packages/sandbox/src/targets/docker/index.js";
import { gitShim } from "./repository.js";

export class DockerFixtureError extends Error {}
const run = async (args: string[], options: { timeout?: number; missingImage?: boolean } = {}) => {
  try {
    const result = await promisify(execFile)("docker", args, {
      timeout: options.timeout ?? 60000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    // Never serialize the child error: it can contain an injected environment.
    const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
    if (
      options.missingImage &&
      failure.code === 1 &&
      typeof failure.stderr === "string" &&
      /No such image/i.test(failure.stderr)
    )
      return "";
    const stage =
      args[0] === "image"
        ? args[1] === "rm"
          ? "image.remove"
          : "image.inspect"
        : args[0] === "build"
          ? "build"
          : args[0] === "ps"
            ? "containers"
            : args[0] === "images"
              ? "images"
              : "command";
    const reason =
      failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "output_limit"
        : failure.killed
          ? "timeout"
          : typeof failure.code === "number"
            ? `exit ${failure.code}`
            : "unavailable";
    throw new DockerFixtureError(`fixture_docker_command_failed: ${stage} (${reason})`);
  }
};

/** Only local image layers and fixture bytes; no host mounts, pulls or provider calls. */
export async function dockerFixture(options: { remote: string; certificate: string }) {
  const base = process.env.ZOLTBOT_M1_DOCKER_IMAGE ?? "zoltbot-base";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,199}$/.test(base))
    throw new Error("fixture_docker_image_invalid");
  try {
    await run(["image", "inspect", base]);
  } catch {
    throw new Error("Build templates/sandbox/Dockerfile as zoltbot-base before Docker M1 tests");
  }
  const image = `zoltbot-m1-fixture:${randomUUID()}`;
  const label = `m1-${randomUUID()}`;
  const journal = path.resolve(".cache/cloud-m1/docker", `${randomUUID()}.json`);
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, JSON.stringify({ image, label }), { flag: "wx" });
  const removeImage = async () => {
    await run(["image", "rm", image], { timeout: 180000, missingImage: true });
    await rm(journal, { force: true });
  };
  const context = await mkdtemp("/private/tmp/zoltbot-m1-image-");
  const raw = createDockerTarget({ image, label });
  const home = "/home/user/fixture",
    bin = `${home}/bin`,
    fixture = path.join(context, "fixture");
  const writeFixture = async (relative: string, data: string | Uint8Array, mode = 0o644) => {
    const destination = path.join(fixture, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data, { mode });
  };
  try {
    for (const provider of ["claude", "codex"] as const) {
      const bundle = await build({
        entryPoints: [`tools/fakes/src/${provider}-conformance-provider.ts`],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        target: "node22",
        banner: {
          js: 'import { createRequire as fixtureRequire } from "node:module"; const require = fixtureRequire(import.meta.url);',
        },
        logLevel: "silent",
      });
      const source = bundle.outputFiles[0]?.text;
      if (!source) throw new Error("fixture_provider_build_failed");
      await writeFixture(`tools/fakes/src/${provider}-conformance-provider.mjs`, source);
      await writeFixture(
        `bin/${provider}`,
        `#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2);
if(${JSON.stringify(provider)}==="codex"&&args[0]==="app-server"&&args[1]==="generate-json-schema"){const out=args[args.indexOf("--out")+1];if(!out||!require("node:path").isAbsolute(out))process.exit(1);fs.copyFileSync(${JSON.stringify(`${home}/fixtures/codex/0.164.0/protocol-experimental.schema.json`)},require("node:path").join(out,"codex_app_server_protocol.schemas.json"));process.exit(0);}
if(args.includes("--version")){process.stdout.write(${JSON.stringify(provider === "claude" ? "2.1.299 (Claude Code)\n" : "codex-cli 0.164.0\n")});process.exit(0);}
const child=require("node:child_process").spawn(process.execPath,[${JSON.stringify(`${home}/tools/fakes/src/${provider}-conformance-provider.mjs`)},...args],{stdio:"inherit",env:process.env});child.once("error",()=>process.exitCode=1);child.once("exit",code=>process.exitCode=code??1);
`,
        0o700,
      );
    }
    for (const name of ["protocol-experimental.schema.json", "thread-start-no-auth.jsonl"])
      await writeFixture(
        `fixtures/codex/0.164.0/${name}`,
        await readFile(`fixtures/codex/0.164.0/${name}`),
      );
    await writeFixture(
      "bin/git",
      `#!/usr/bin/env node\n${gitShim(options.remote, "/usr/bin/git", `${home}/ca.pem`)}\n`,
      0o700,
    );
    await writeFixture("trust.mjs", await readFile("tests/cloud-m1/trust.mjs"));
    await writeFixture("ca.pem", options.certificate);
    // A retry can discover the labeled container as soon as Docker creates it.
    // Put all fixture files in the image so discovery cannot race an upload.
    await writeFile(
      path.join(context, "Dockerfile"),
      `FROM ${base}\nUSER root\nRUN rm -f /usr/local/bin/claude /usr/local/bin/codex\nCOPY worker.mjs /opt/zoltbot/apps/worker/dist/main.mjs\nCOPY --chown=user:user fixture/ ${home}/\nUSER user\nENTRYPOINT []\n`,
    );
    await copyFile("apps/worker/dist/main.mjs", path.join(context, "worker.mjs"));
    // Each fixture owns its image even when BuildKit reuses its layers.
    await run([
      "build",
      "--pull=false",
      "--network=none",
      "--label",
      `ai.zoltbot.m1-fixture=${label}`,
      "--tag",
      image,
      context,
    ]);
    const target: ExecutionTarget = {
      ...raw,
      create: (spec) => raw.create({ ...spec, template: image }),
    };
    return Object.freeze({
      target,
      command: ["node", "/opt/zoltbot/apps/worker/dist/main.mjs"],
      environment: {
        PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
        NODE_OPTIONS: `--import=${home}/trust.mjs`,
        GIT_SSL_CAINFO: `${home}/ca.pem`,
        ZOLTBOT_TEST_CA_CERTIFICATE: options.certificate,
      },
      async close() {
        await raw.removeAll();
        const filter = `label=ai.zoltbot.sandbox=${label}`;
        const containers = await run(["ps", "--all", "--quiet", "--filter", filter]);
        const images = await run(["images", "--quiet", "--filter", filter]);
        if (containers.trim() || images.trim())
          throw new DockerFixtureError("fixture_docker_cleanup_pending");
        await removeImage();
      },
    });
  } catch (error) {
    await removeImage().catch(() => {});
    if (error instanceof DockerFixtureError) throw error;
    throw new Error("fixture_docker_setup_failed");
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}
