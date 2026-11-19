import type { CompanyChange } from "@zoltbot/protocol";
import type { CompanyOverview, CompanyPerson } from "../shared/ipc";
import { companyTree } from "./company-tree";
import type { Row, Snapshot } from "./daemon-client";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/** The parts of a `company.read` result the Organization panel uses. */
export interface CompanyReadResult {
  teams?: Row[];
  managers?: Row[];
  initiatives?: Row[];
  tasks?: Row[];
  plans?: Row[];
  briefs?: Row[];
}

/**
 * Turns the daemon's view of one project's company into what the Organization panel shows:
 * the CEO, each team with its manager and head count, plans waiting for a decision, the
 * initiatives under way and the latest project brief.
 */
export function toCompanyOverview(
  projectId: string,
  read: CompanyReadResult,
  snapshot: Snapshot,
): CompanyOverview {
  const project = (snapshot.entities.project ?? []).find((row) => row.id === projectId);
  const tree = companyTree(snapshot).entries.filter((entry) => entry.projectId === projectId);
  const threads = new Map((snapshot.entities.thread ?? []).map((row) => [text(row.id), row]));
  const person = (threadId: unknown): CompanyPerson | null => {
    const thread = threads.get(text(threadId));
    if (!thread || thread.archived === true) return null;
    return { botId: text(thread.id), name: text(thread.title) || "Untitled chat" };
  };
  const employeesUnder = (managerId: string) =>
    tree.filter((entry) => entry.parentId === managerId && entry.role === "employee").length;

  const ceoEntry = tree.find((entry) => entry.role === "ceo");
  const ceo = ceoEntry ? person(ceoEntry.thread.id) : null;
  const managers = rows(read.managers);
  const teams = rows(read.teams).map((team) => {
    const manager = managers.find((row) => (row.node as Row | undefined)?.id === team.id);
    const lead = manager ? person(manager.id) : null;
    return {
      id: text(team.id),
      name: text(team.name) || "Team",
      manager: lead,
      employees: lead ? employeesUnder(lead.botId) : 0,
    };
  });

  const name = namer(snapshot, read);
  const pendingPlans = rows(read.plans)
    .filter((plan) => plan.state === "proposed")
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))
    .map((plan) => ({
      id: text(plan.id),
      title: text(plan.title),
      explanation: text(plan.explanation),
      version: Number(plan.version) || 1,
      changes: rows(plan.changes).map((change) => ({
        summary: describeChange(change as CompanyChange, name),
        why: text(change.why),
      })),
    }));

  const initiatives = rows(read.initiatives)
    .filter((row) => ["active", "review", "paused", "proposed"].includes(text(row.state)))
    .map((row) => {
      const progress = (row.progress ?? {}) as Row;
      return {
        id: text(row.id),
        title: text(row.title),
        outcome: text(row.outcome),
        priority: text(row.priority),
        state: text(row.state),
        owner: person(row.managerThreadId),
        finished: Number(progress.finished) || 0,
        total: Number(progress.total) || 0,
      };
    });

  const latest = rows(read.briefs)
    .slice()
    .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)))[0];

  return {
    projectId,
    projectName: text(project?.name) || "Project",
    ceo,
    ceoEmployees: ceo ? employeesUnder(ceo.botId) : 0,
    teams,
    pendingPlans,
    initiatives,
    brief: latest
      ? {
          day: text(latest.day),
          revision: Number(latest.revision) || 1,
          summary: text(latest.summary),
          createdAt: text(latest.createdAt),
        }
      : null,
  };
}

/** Names a chat, team, initiative, task or project by id, including ones a plan would create. */
function namer(snapshot: Snapshot, read: CompanyReadResult): (id: unknown) => string {
  const names = new Map<string, string>();
  const add = (id: unknown, value: unknown) => {
    if (text(id) && text(value) && !names.has(text(id))) names.set(text(id), text(value));
  };
  for (const row of snapshot.entities.thread ?? []) add(row.id, row.title);
  for (const row of snapshot.entities.project ?? []) add(row.id, row.name);
  for (const row of snapshot.entities.subproject ?? []) add(row.id, row.name);
  for (const row of rows(read.initiatives)) add(row.id, row.title);
  for (const row of rows(read.tasks)) add(row.id, row.title);
  for (const plan of rows(read.plans))
    for (const change of rows(plan.changes)) {
      if (change.kind === "team") add(change.id, change.name);
      if (change.kind === "chat") add(change.id, change.title);
      const value = change.value as Row | undefined;
      if (value) add(value.id, value.title);
    }
  return (id) => names.get(text(id)) ?? "someone new";
}

/** One line per change, written for the person deciding whether to approve the plan. */
export function describeChange(change: CompanyChange, name: (id: unknown) => string): string {
  switch (change.kind) {
    case "assignManager":
      return `Make ${name(change.id)} the manager of ${name(change.parent.id)}`;
    case "moveTask":
      return change.initiativeId
        ? `Move ${name(change.id)} to ${name(change.initiativeId)}`
        : `Move ${name(change.id)} out of its initiative`;
    case "team":
      return `Create the ${change.name} team under ${name(change.parent.id)}`;
    case "chat":
      return `Hire ${change.title} as ${change.manager ? "manager" : "employee"} in ${name(change.parent.id)}`;
    case "initiative":
      return `Set initiative ${change.value.title}: ${change.value.outcome}`;
    case "remit":
      return `Set responsibilities for ${name(change.value.threadId)}: ${change.value.responsibilities}`;
    case "task":
      return `Assign ${change.value.title}: ${change.value.brief}`;
    case "renameTeam":
      return `Rename ${name(change.id)} to ${change.name}`;
    case "archiveTeam":
      return `Archive ${name(change.id)}`;
    case "moveTeam":
      return `Move ${name(change.id)} under ${name(change.parent.id)}`;
    case "moveChat":
      return `Move ${name(change.id)} to ${name(change.parent.id)}`;
    case "assignTask":
      return `Make ${name(change.accountableThreadId)} accountable for ${name(change.id)}`;
    case "releaseTask":
      return `Start ${name(change.id)}`;
    default:
      return "Change the organization";
  }
}
