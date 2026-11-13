import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Disposable bare remote and protocol fakes; no real GitHub or provider process can be reached. */
export async function harnessRepository(root: string) {
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git"),
    bin = path.join(root, "bin");
  await mkdir(source, { recursive: true });
  await mkdir(bin, { recursive: true });
  const realGit = execFileSync("which", ["git"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (cwd: string, args: string[]) => {
    try {
      return execFileSync(
        realGit,
        ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args],
        { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      throw new Error("fixture_repository_failed");
    }
  };
  git(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "README.md"), "Cloud milestone fixture\n");
  await writeFile(
    path.join(source, ".gitignore"),
    "claude-native.json\ncodex-native.json\npermission-updates.json\nenvironment-keys.json\n",
  );
  git(source, ["add", "."]);
  git(source, [
    "-c",
    "user.name=Zolt Labs",
    "-c",
    "user.email=zolt@zoltbot.ai",
    "commit",
    "-m",
    "Seed cloud fixture",
  ]);
  git(root, ["clone", "--bare", source, remote]);
  const script = async (name: string, contents: string) => {
    const file = path.join(bin, name);
    await writeFile(file, `#!/usr/bin/env node\n${contents}\n`, { mode: 0o700 });
    await chmod(file, 0o700);
  };
  for (const provider of ["claude", "codex"] as const) {
    const implementation = path.resolve(`tools/fakes/src/${provider}-conformance-provider.ts`);
    await script(
      provider,
      `
const args=process.argv.slice(2);
if(${JSON.stringify(provider)}==="codex"&&args[0]==="app-server"&&args[1]==="generate-json-schema"){const output=args[args.indexOf("--out")+1];if(!output||!require("node:path").isAbsolute(output))process.exit(1);require("node:fs").copyFileSync(${JSON.stringify(path.resolve("fixtures/codex/0.164.0/protocol-experimental.schema.json"))},require("node:path").join(output,"codex_app_server_protocol.schemas.json"));process.exit(0);}
if(args.includes("--version")){process.stdout.write(${JSON.stringify(provider === "claude" ? "2.1.299 (Claude Code)\n" : "codex-cli 0.164.0\n")});process.exit(0);}
const child=require("node:child_process").spawn(process.execPath,["--import",${JSON.stringify(import.meta.resolve("tsx"))},${JSON.stringify(implementation)},...args],{stdio:"inherit",env:{...process.env,TSX_DISABLE_CACHE:"1"}});
child.once("error",()=>{process.exitCode=1;});child.once("exit",code=>{process.exitCode=code??1;});`,
    );
  }
  await script(
    "git",
    `
const child=require("node:child_process"),args=process.argv.slice(2),remote=${JSON.stringify(remote)},canonical="https://github.com/example/repository.git";
let offset=0;while(args[offset]?.startsWith("-")){offset+=["-c","-C","--git-dir","--work-tree"].includes(args[offset])?2:1;}
const operation=args[offset],network=["clone","fetch","push","ls-remote"].includes(operation);
const safe=["add","branch","cat-file","check-ref-format","checkout","clone","commit-tree","config","diff","diff-index","diff-tree","fetch","for-each-ref","hash-object","init","ls-files","ls-remote","ls-tree","merge-base","push","read-tree","reset","rev-list","rev-parse","show","show-ref","status","switch","symbolic-ref","update-index","update-ref","worktree","write-tree"];
if(!safe.includes(operation)&&args[0]!=="--version"){process.stderr.write("fixture_git_command_refused\\n");process.exit(127);}
const rewritten=network?args.map(value=>value===canonical||value==="origin"?remote:value):args;
if(!network&&args.some(value=>/^(?:https?|ssh|git):|^git@|^--remote(?:=|$)/.test(value))){process.stderr.write("fixture_git_network_refused\\n");process.exit(127);}
if(network&&(!rewritten.includes(remote)||rewritten.some(value=>/^(?:https?|ssh|git):|^git@/.test(value)))){process.stderr.write("fixture_git_network_refused\\n");process.exit(127);}
const result=child.spawnSync(${JSON.stringify(realGit)},rewritten,{stdio:"inherit",env:process.env});
if(operation==="clone"&&result.status===0){const destination=rewritten.at(-1);const config=child.spawnSync(${JSON.stringify(realGit)},["-C",destination,"config","remote.origin.url",canonical],{stdio:"ignore",env:process.env});if(config.status!==0)process.exit(1);}
process.exit(result.status??1);`,
  );
  return Object.freeze({ bin, remote, source, git });
}
