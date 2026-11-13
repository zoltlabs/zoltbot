import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { ExecutionTarget } from "../../packages/sandbox/src/interface.js";
import { createDockerTarget } from "../../packages/sandbox/src/targets/docker/index.js";
import { gitShim } from "./repository.js";

const run = async (args: string[]) => {
  try {
    await promisify(execFile)("docker", args, { timeout: 60000, maxBuffer: 1024 * 1024 });
  } catch {
    // CLI errors must never render a container's injected environment.
    throw new Error("fixture_docker_command_failed");
  }
};

/** Only local image layers and uploaded test bytes; no host mounts, pulls or provider calls. */
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
  const context = await mkdtemp("/private/tmp/zoltbot-m1-image-");
  try {
    await writeFile(
      path.join(context, "Dockerfile"),
      `FROM ${base}\nUSER root\nRUN rm -f /usr/local/bin/claude /usr/local/bin/codex\nCOPY worker.mjs /opt/zoltbot/apps/worker/dist/main.mjs\nUSER user\nENTRYPOINT []\n`,
    );
    await copyFile("apps/worker/dist/main.mjs", path.join(context, "worker.mjs"));
    await run(["build", "--pull=false", "--network=none", "--tag", image, context]);
  } catch (error) {
    await run(["image", "rm", image]).catch(() => {});
    throw error;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
  const raw = createDockerTarget({ image, label: `m1-${randomUUID()}` });
  const home = "/home/user/fixture",
    bin = `${home}/bin`;
  const files = new Map<string, string | Uint8Array>();
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
      files.set(`${home}/tools/fakes/src/${provider}-conformance-provider.mjs`, source);
      files.set(
        `${bin}/${provider}`,
        `#!/usr/bin/env node
const fs=require("node:fs"),args=process.argv.slice(2);
if(${JSON.stringify(provider)}==="codex"&&args[0]==="app-server"&&args[1]==="generate-json-schema"){const out=args[args.indexOf("--out")+1];if(!out||!require("node:path").isAbsolute(out))process.exit(1);fs.copyFileSync(${JSON.stringify(`${home}/fixtures/codex/0.164.0/protocol-experimental.schema.json`)},require("node:path").join(out,"codex_app_server_protocol.schemas.json"));process.exit(0);}
if(args.includes("--version")){process.stdout.write(${JSON.stringify(provider === "claude" ? "2.1.299 (Claude Code)\n" : "codex-cli 0.164.0\n")});process.exit(0);}
const child=require("node:child_process").spawn(process.execPath,[${JSON.stringify(`${home}/tools/fakes/src/${provider}-conformance-provider.mjs`)},...args],{stdio:"inherit",env:process.env});child.once("error",()=>process.exitCode=1);child.once("exit",code=>process.exitCode=code??1);
`,
      );
    }
    for (const name of ["protocol-experimental.schema.json", "thread-start-no-auth.jsonl"])
      files.set(
        `${home}/fixtures/codex/0.164.0/${name}`,
        await readFile(`fixtures/codex/0.164.0/${name}`),
      );
    files.set(
      `${bin}/git`,
      `#!/usr/bin/env node\n${gitShim(options.remote, "/usr/bin/git", `${home}/ca.pem`)}\n`,
    );
    files.set(`${home}/trust.mjs`, await readFile("tests/cloud-m1/trust.mjs"));
    files.set(`${home}/ca.pem`, options.certificate);
    const target: ExecutionTarget = {
      ...raw,
      async create(spec) {
        const ref = await raw.create({ ...spec, template: image });
        try {
          for (const [file, data] of files) await raw.files.write(ref, file, data);
          const setup = await raw.exec(ref, [
            "chmod",
            "700",
            `${bin}/claude`,
            `${bin}/codex`,
            `${bin}/git`,
          ]);
          if ((await setup.exit).code !== 0) throw new Error("fixture_provider_setup_failed");
          return ref;
        } catch {
          await raw.destroy(ref);
          throw new Error("fixture_provider_setup_failed");
        }
      },
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
        await run(["image", "rm", image]);
      },
    });
  } catch {
    await run(["image", "rm", image]).catch(() => {});
    throw new Error("fixture_docker_setup_failed");
  }
}
