import { build } from "esbuild";
import { Log, LogLevel, Miniflare, Response as WorkerResponse } from "miniflare";

/** Real Cell runtime, bundled in memory, with all outbound fetches restricted to loopback. */
export async function startTestCell(options: {
  directory: string;
  jwksUrl: string;
  issuer: string;
  orchestratorUrl: string;
  serviceKey: string;
}) {
  if (process.env.MINIFLARE_WORKERD_CONFIG_DEBUG)
    throw new Error("fixture_cell_configuration_invalid");
  for (const target of [options.jwksUrl, options.orchestratorUrl]) {
    const url = new URL(target);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
      throw new Error("fixture_cell_configuration_invalid");
  }
  let runtime: Miniflare | undefined,
    refused = 0;
  const paths: string[] = [];
  try {
    const bundle = await build({
      entryPoints: ["packages/cell/src/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      logLevel: "silent",
    });
    const source = bundle.outputFiles[0]?.text;
    if (!source) throw new Error();
    runtime = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      enableDevRegistry: false,
      resourcePersistencePath: options.directory,
      log: new Log(LogLevel.NONE),
      workers: [
        {
          config: {
            name: "m1-cell",
            compatibilityDate: "2026-11-11",
            manifest: {
              mainModule: "worker.mjs",
              modules: { "worker.mjs": { type: "esm", contents: source } },
            },
            exports: { OrgCell: { type: "durable-object", storage: "sqlite" } },
            env: {
              ORG_CELLS: { type: "durable-object", worker: "m1-cell", exportName: "OrgCell" },
              CELL_JWKS_URL: { type: "json", value: options.jwksUrl },
              CELL_JWT_ISSUER: { type: "json", value: options.issuer },
              ORCHESTRATOR_URL: { type: "json", value: options.orchestratorUrl },
              ORCHESTRATOR_SIGNING_KEY: { type: "json", value: options.serviceKey },
            },
          },
          dev: {
            outboundService: {
              type: "fetcher",
              async handler(request) {
                const url = new URL(request.url);
                paths.push(url.pathname);
                if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
                  refused++;
                  throw new Error("fixture_external_network_refused");
                }
                const response = await fetch(url, {
                  method: request.method,
                  headers: Object.fromEntries(request.headers.entries()),
                  ...(["GET", "HEAD"].includes(request.method)
                    ? {}
                    : { body: await request.arrayBuffer() }),
                  redirect: "error",
                  signal: AbortSignal.timeout(5000),
                });
                return new WorkerResponse(await response.arrayBuffer(), {
                  status: response.status,
                  headers: Object.fromEntries(response.headers.entries()),
                });
              },
            },
          },
        },
      ],
    });
    const origin = (await runtime.ready).origin,
      owned = runtime;
    let closing: Promise<void> | undefined;
    return Object.freeze({
      origin: () => origin,
      refusedNetwork: () => refused,
      outboundPaths: () => [...paths],
      close: () => (closing ??= owned.dispose()),
    });
  } catch {
    await runtime?.dispose().catch(() => {});
    throw new Error("fixture_cell_start_failed");
  }
}
