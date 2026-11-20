/** Someone in a project's company, linked to their chat. */
export interface CompanyPerson {
  botId: string;
  name: string;
}

export interface CompanyTeam {
  id: string;
  name: string;
  manager: CompanyPerson | null;
  employees: number;
}

export interface CompanyPlanChange {
  summary: string;
  why: string;
}

export interface CompanyPlanSummary {
  id: string;
  title: string;
  explanation: string;
  version: number;
  changes: CompanyPlanChange[];
}

export interface CompanyInitiative {
  id: string;
  title: string;
  outcome: string;
  priority: string;
  state: string;
  owner: CompanyPerson | null;
  finished: number;
  total: number;
}

export interface CompanyBrief {
  day: string;
  revision: number;
  summary: string;
  createdAt: string;
}

/** What the Organization panel shows for one project. */
export interface CompanyOverview {
  projectId: string;
  projectName: string;
  ceo: CompanyPerson | null;
  /** Employees reporting straight to the CEO. */
  ceoEmployees: number;
  teams: CompanyTeam[];
  pendingPlans: CompanyPlanSummary[];
  initiatives: CompanyInitiative[];
  brief: CompanyBrief | null;
}

export interface DecidePlanInput {
  projectId: string;
  planId: string;
  version: number;
  approve: boolean;
}
