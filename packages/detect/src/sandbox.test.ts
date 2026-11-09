import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { probeCommand } from "./probe.js";
import { macProbeSandbox } from "./sandbox.js";

it("isolates probe HOME, cwd, network, writes, and credentials before the handshake", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/probe-"));
  try {
    const sandbox = macProbeSandbox({
      dataDir: root,
      paths: [],
      platform: "darwin",
      runner: async (command, args, options) => {
        expect(command).toBe("/usr/bin/sandbox-exec");
        expect(args[1]).toContain("(deny default)");
        expect(args[1]).not.toContain("allow network");
        expect(options.timeoutMs).toBe(10000);
        expect(options.inherited).toEqual({});
        expect(options.env?.HOME).toContain(root);
        expect(options.cwd).not.toBe(options.env?.HOME);
        expect(JSON.parse(options.input ?? "").method).toBe("initialize");
        expect(
          options.stopWhen?.(
            '{"jsonrpc":"2.0","id":"zoltbot-probe","result":{"protocolVersion":1}}\n',
          ),
        ).toBe(true);
        return {
          code: null,
          stdout: '{"jsonrpc":"2.0","id":"zoltbot-probe","result":{"protocolVersion":1}}\n',
          stderr: "",
        };
      },
    });
    expect(await sandbox.initialize([process.execPath])).toEqual({ protocolVersion: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("turns a pasted executable command into a definition through the real sandbox", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/probe-command-"));
  try {
    const { writeFileSync, readdirSync } = await import("node:fs");
    const fixture = path.join(root, "opencode");
    const packageFile = path.join(root, "package.json");
    writeFileSync(packageFile, JSON.stringify({ type: "commonjs" }));
    writeFileSync(
      fixture,
      `#!${process.execPath}
if(process.argv[2]!=='acp')process.exit(2);
let input='';process.stdin.on('data',bytes=>{input+=bytes;if(!input.includes('\\n'))return;const request=JSON.parse(input.trim());console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:true}},agentInfo:{name:'fixture',version:'1.0.0'}}}));});`,
      { mode: 0o700 },
    );
    const result = await probeCommand(
      "opencode acp",
      macProbeSandbox({
        dataDir: root,
        paths: [root],
        runtimeReadRoots: [path.dirname(path.dirname(process.execPath))],
        runtimeReadFiles: [packageFile],
      }),
    );
    if (process.platform !== "darwin") {
      expect(result).toEqual({ error: "probe_failed" });
    } else {
      expect(result.definition).toMatchObject({
        adapter: "acp",
        displayName: "fixture",
        launch: { command: "opencode", args: ["acp"] },
        staticCapabilities: { resume: true, images: false, hostTools: "mcp_http" },
      });
      expect(readdirSync(path.join(root, "probes"))).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("runs a real local ACP fixture through the platform isolation boundary", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/probe-native-"));
  try {
    const { writeFileSync, existsSync } = await import("node:fs");
    const fixture = path.join(root, "fixture.cjs");
    const secret = path.join(root, "private-fixture.txt"),
      forbidden = path.join(root, "forbidden.txt");
    writeFileSync(secret, "synthetic private fixture");
    writeFileSync(
      fixture,
      `const fs=require('node:fs'),net=require('node:net');let readBlocked=false,writeBlocked=false;
      try{fs.readFileSync(${JSON.stringify(secret)})}catch{readBlocked=true}
      try{fs.writeFileSync(${JSON.stringify(forbidden)},'forbidden')}catch{writeBlocked=true}
      let input='';process.stdin.on('data',bytes=>{input+=bytes;if(!input.includes('\\n'))return;const request=JSON.parse(input.trim());const socket=net.connect(9,'127.0.0.1');socket.on('error',error=>console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:'fixture',version:'1.0.0'},_meta:{readBlocked,writeBlocked,networkBlocked:error.code==='EPERM'||error.code==='EACCES'}}})));});`,
    );
    const sandbox = macProbeSandbox({
      dataDir: root,
      paths: [],
      runtimeReadRoots: [path.dirname(path.dirname(process.execPath))],
      runtimeReadFiles: [fixture],
    });
    if (process.platform !== "darwin") {
      await expect(sandbox.initialize([process.execPath, fixture])).rejects.toThrow(
        "probe_sandbox_unavailable",
      );
    } else {
      expect(await sandbox.initialize([process.execPath, fixture])).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: "fixture" },
        _meta: { readBlocked: true, writeBlocked: true, networkBlocked: true },
      });
    }
    expect(existsSync(forbidden)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
