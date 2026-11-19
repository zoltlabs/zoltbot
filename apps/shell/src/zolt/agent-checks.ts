import type { AgentProviderState, AgentProviderStatus } from "../shared/ipc";
import type { Row } from "./daemon-client";

/** What the daemon's last `doctor.report` said, or that it couldn't be read. */
export type AgentChecks = Map<string, Row> | "failed" | undefined;

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The agent rows of a `doctor.report` result, keyed by agent definition id. */
export function agentChecks(report: unknown): Map<string, Row> {
  const checks = record(report).checks;
  const rows = Array.isArray(checks) ? checks.map(record) : [];
  return new Map(
    rows
      .filter((row) => row.kind === "agent" && text(row.definitionId))
      .map((row) => [text(row.definitionId), row]),
  );
}

/**
 * One status per agent definition the daemon knows. Install and sign-in state come from the
 * daemon's checks; until those arrive every agent reads as checking.
 */
export function providerStatuses(
  definitions: Row[],
  checks: AgentChecks,
  online: boolean,
): AgentProviderStatus[] {
  return definitions.map((definition) => {
    const id = text(definition.id);
    const name = text(definition.displayName) || id;
    const check = checks instanceof Map ? checks.get(id) : undefined;
    const selected = record(record(check?.install).selected);
    const install = record(definition.install);
    const login = record(definition.auth).loginCommand;
    const binary = Array.isArray(definition.binaryNames) ? text(definition.binaryNames[0]) : "";
    const { state, message } = providerState(name, online, checks, check, selected);
    return {
      id,
      name,
      state,
      version: text(selected.version) || null,
      message,
      installUrl: text(install.docsUrl) || null,
      installCommand: text(install.command) || null,
      loginCommand:
        binary && Array.isArray(login) && login.every((part) => typeof part === "string")
          ? [binary, ...login].join(" ")
          : null,
    };
  });
}

function providerState(
  name: string,
  online: boolean,
  checks: AgentChecks,
  check: Row | undefined,
  selected: Row,
): { state: AgentProviderState; message: string | null } {
  if (!online) return { state: "not-started", message: null };
  if (checks === "failed") return { state: "error", message: `Couldn’t check ${name}.` };
  if (!check) return { state: "checking", message: null };
  if (!text(selected.path)) return { state: "not-installed", message: `${name} isn’t installed.` };
  if (selected.state === "broken") return { state: "error", message: `${name} didn’t start.` };
  if (selected.support === "unsupported")
    return { state: "outdated", message: `Update ${name} to a supported version.` };
  if (record(check.login).state === "signed_out")
    return { state: "sign-in-required", message: `Sign in to ${name}.` };
  return { state: "available", message: null };
}
