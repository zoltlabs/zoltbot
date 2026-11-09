import { createHash } from "node:crypto";
import type {
  ArtifactBinding,
  BrowserBinding,
  ContextPack,
  HostToolDefinition,
  Scope,
} from "@zoltbot/protocol";

/** Public, immutable launch inputs. Credential values must never enter this object. */
export interface ConnectionDescriptor {
  id: string;
  version: number;
  name: string;
  projectId: string;
  transport: { kind: "https"; url: string } | { kind: "stdio"; command: string; args: string[] };
  credentialReference?: string;
  posthog?: { projectId: string };
  schemaTokens: { value: number; source: "estimated" | "measured" };
}
export interface SkillContribution {
  id: string;
  revision: number;
  hash: string;
  path: string;
  wrapperTokens: number;
}
export interface KnowledgeContribution {
  pack?: ContextPack;
  scope?: Scope;
  scopeHash?: string;
  packId: string;
  text: string;
  tokens: number;
}
export interface LaunchManifest {
  version: 1;
  id: string;
  executionId: string;
  threadId: string;
  taskId?: string;
  taskRevision?: number;
  projectId?: string;
  profileId: string;
  configurationHash: string;
  cwd: string;
  browser?: BrowserBinding;
  artifact?: ArtifactBinding;
  hostTools?: HostToolDefinition[];
  baseCommit?: string;
  connections: ConnectionDescriptor[];
  skills: SkillContribution[];
  knowledge?: KnowledgeContribution;
  budget: { limit: number; fixed: number; connections: number; skills: number; knowledge: number };
}
export interface LaunchContributions {
  connections?: ConnectionDescriptor[];
  skills?: SkillContribution[];
  knowledge?: KnowledgeContribution;
  browser?: BrowserBinding;
  artifact?: ArtifactBinding;
  hostTools?: HostToolDefinition[];
  baseCommit?: string;
}
export type LaunchIdentity = Pick<
  LaunchManifest,
  | "executionId"
  | "threadId"
  | "taskId"
  | "taskRevision"
  | "projectId"
  | "profileId"
  | "cwd"
  | "configurationHash"
>;
export function composeLaunchManifest(
  identity: LaunchIdentity,
  contributions: LaunchContributions = {},
  budget: { limit: number; fixed: number },
): LaunchManifest {
  const connections = structuredClone(contributions.connections ?? []);
  const skills = structuredClone(contributions.skills ?? []);
  const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const counts = {
    ...budget,
    connections: connections.reduce((n, c) => n + c.schemaTokens.value, 0),
    skills: skills.reduce((n, s) => n + s.wrapperTokens, 0),
    knowledge: contributions.knowledge?.tokens ?? 0,
  };
  if (!Object.values(counts).every(nonnegative)) throw new Error("invalid_launch_budget");
  if (counts.fixed + counts.connections + counts.skills + counts.knowledge > counts.limit)
    throw new Error("context_budget_hold");
  if (new Set(connections.map((c) => c.id)).size !== connections.length)
    throw new Error("duplicate_connection");
  if (new Set(connections.map((c) => c.name)).size !== connections.length)
    throw new Error("duplicate_connection_name");
  for (const connection of connections) {
    if (!identity.projectId || connection.projectId !== identity.projectId)
      throw new Error("connection_scope_denied");
    if (connection.name === "zoltbot") throw new Error("reserved_connection_name");
  }
  const body = {
    version: 1 as const,
    ...identity,
    ...(contributions.artifact ? { artifact: structuredClone(contributions.artifact) } : {}),
    ...(contributions.hostTools ? { hostTools: structuredClone(contributions.hostTools) } : {}),
    ...(contributions.browser ? { browser: structuredClone(contributions.browser) } : {}),
    ...(contributions.baseCommit ? { baseCommit: contributions.baseCommit } : {}),
    connections,
    skills,
    ...(contributions.knowledge ? { knowledge: structuredClone(contributions.knowledge) } : {}),
    budget: counts,
  };
  const id = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, id };
}
