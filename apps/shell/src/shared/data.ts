// M8: what the Data page reads over IPC: each project's shared database, read-only.

/** A value in a row. A blob is given by its size. */
export type DataCell = string | number | null | { bytes: number };

export interface DataTable {
  name: string;
  columns: string[];
  rows: number;
}

export interface DataProject {
  id: string;
  name: string;
}

export interface DataTables {
  tables: DataTable[];
  bytes: number;
  limitBytes: number;
}

export interface DataRows {
  columns: string[];
  rows: DataCell[][];
  total: number;
}

export interface DataCsv {
  /** A file name for the download. */
  name: string;
  csv: string;
  /** The table was larger than one export holds. */
  truncated: boolean;
}

export const DATA_CHANNELS = {
  dataProjects: "data:projects",
  dataTables: "data:tables",
  dataRows: "data:rows",
  dataCsv: "data:csv",
} as const;

export interface DataDesktopApi {
  projects: () => Promise<DataProject[]>;
  tables: (projectId: string) => Promise<DataTables>;
  rows: (input: {
    projectId: string;
    table: string;
    offset: number;
    limit: number;
  }) => Promise<DataRows>;
  csv: (input: { projectId: string; table: string }) => Promise<DataCsv>;
}
