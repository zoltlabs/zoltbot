// M8: the Data page's daemon calls. Reads only; agents write with their own tools.
import type { DataCsv, DataProject, DataRows, DataTables } from "../shared/data";
import { IPC_CHANNELS } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { text } from "./mapping";
import { isObject, requireString } from "./parsers";

type Row = Record<string, unknown>;

function parseTable(input: unknown): { projectId: string; table: string } {
  if (!isObject(input)) throw new Error("Invalid table.");
  const table = requireString(input.table, "table");
  if (table.length > 4096) throw new Error("Invalid table.");
  return { projectId: requireString(input.projectId, "projectId"), table };
}

function parseRows(input: unknown) {
  const table = parseTable(input);
  const values = input as Row;
  const offset = Number(values.offset ?? 0);
  const limit = Number(values.limit ?? 100);
  if (!Number.isInteger(offset) || offset < 0) throw new Error("Invalid page.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid page.");
  return { ...table, offset, limit };
}

/** A file name from the table's name, without characters a Mac file name can't hold. */
export function csvFileName(table: string): string {
  const base = table.replace(/[/:\\\0]/g, "-").trim() || "table";
  return `${base.slice(0, 120)}.csv`;
}

export function dataService(client: DaemonClient) {
  return {
    projects(): DataProject[] {
      const rows = ((client.snapshot.entities as Record<string, Row[] | undefined>).project ??
        []) as Row[];
      return rows
        .filter((row) => row.archived !== true)
        .map((row) => ({ id: text(row.id), name: text(row.name) || "Untitled project" }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async tables(projectId: string): Promise<DataTables> {
      return (await client.call("projectData.tables", { projectId })) as DataTables;
    },
    async rows(input: ReturnType<typeof parseRows>): Promise<DataRows> {
      return (await client.call("projectData.rows", input)) as DataRows;
    },
    async csv(input: { projectId: string; table: string }): Promise<DataCsv> {
      const result = (await client.call("projectData.csv", input)) as {
        csv: string;
        truncated: boolean;
      };
      return { name: csvFileName(input.table), ...result };
    },
  };
}

export function dataHandlers(client: DaemonClient): Record<string, (input: unknown) => unknown> {
  const service = dataService(client);
  return {
    [IPC_CHANNELS.dataProjects]: () => service.projects(),
    [IPC_CHANNELS.dataTables]: (projectId) => service.tables(requireString(projectId, "projectId")),
    [IPC_CHANNELS.dataRows]: (input) => service.rows(parseRows(input)),
    [IPC_CHANNELS.dataCsv]: (input) => service.csv(parseTable(input)),
  };
}
