import type { AgentDefinition } from "@zoltbot/protocol";
import { isNewerRelease, versionFromOutput } from "./versions.js";

export type LatestSource = NonNullable<AgentDefinition["update"]>["latest"];
export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Release server names for this machine, matching the providers' own install scripts. */
export function releaseUrl(
  template: string,
  platform: string = process.platform,
  arch: string = process.arch,
) {
  return template
    .replaceAll("{os}", platform)
    .replaceAll("{arch}", arch === "x64" ? "amd64" : arch);
}

/** Reads the newest published version. Only the version string leaves this function. */
export async function fetchLatest(
  source: LatestSource,
  fetcher: Fetcher = fetch,
): Promise<string | undefined> {
  const url = releaseUrl(source.url);
  if (!url.startsWith("https://")) return undefined;
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return undefined;
  const body = (await response.text()).slice(0, 1_000_000);
  let text: string | undefined;
  if (source.key) {
    try {
      const value: unknown = JSON.parse(body);
      const field =
        value && typeof value === "object" ? (value as Record<string, unknown>)[source.key] : "";
      if (typeof field === "string") text = field;
    } catch {
      return undefined;
    }
  } else if (source.pattern) {
    text = new RegExp(source.pattern).exec(body)?.[1];
  }
  return text ? versionFromOutput(text) : undefined;
}

export interface UpdateRow {
  definitionId: string;
  displayName: string;
  installed: string;
  latest: string;
  command: string[];
}

/** An update is offered only when both versions parse and the published one is newer. */
export function updateRow(
  definition: AgentDefinition,
  installed: { path: string; version?: string } | undefined,
  latest: string | undefined,
): UpdateRow | undefined {
  if (!definition.update || !installed?.version || !latest) return undefined;
  if (!isNewerRelease(latest, installed.version)) return undefined;
  const binary = installed.path.split("/").pop() ?? installed.path;
  return {
    definitionId: definition.id,
    displayName: definition.displayName,
    installed: installed.version,
    latest,
    command: [binary, ...definition.update.args],
  };
}
