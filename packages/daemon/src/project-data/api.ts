// M8: the Data page's reads. Mac-only; the owner browses a project's shared database.
import type { Store } from "@zoltbot/store";
import type { ProjectDatabases } from "./databases.js";

export function projectDataApi(store: Store, databases: ProjectDatabases | undefined) {
  const project = (params: Record<string, unknown>) => {
    const id = String(params.projectId);
    if (!store.record("project", id)) throw new Error("project_not_found");
    if (!databases) throw new Error("project_db_unavailable");
    return id;
  };
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case "projectData.tables": {
        const id = project(params);
        return {
          tables: (await databases?.tables(id)) ?? [],
          bytes: databases?.bytes(id) ?? 0,
          limitBytes: databases?.maxBytes ?? 0,
        };
      }
      case "projectData.rows":
        return databases?.rows(
          project(params),
          String(params.table),
          typeof params.offset === "number" ? params.offset : 0,
          typeof params.limit === "number" ? params.limit : 100,
        );
      case "projectData.csv":
        return databases?.csv(project(params), String(params.table));
      default:
        return undefined;
    }
  };
}
