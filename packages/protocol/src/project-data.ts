import { type Static, Type } from "@sinclair/typebox";
import { Id, object, Text } from "./common.js";

// M8: each project's shared SQLite database, which its agents write with host tools.
// The owner browses it on the Mac; nothing here writes.

/** A value in a row. A blob is given by its size. */
export const ProjectDataCellSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Null(),
  object({ bytes: Type.Integer({ minimum: 0 }) }),
]);
export type ProjectDataCell = Static<typeof ProjectDataCellSchema>;
export const ProjectDataTableSchema = object({
  name: Text,
  columns: Type.Array(Text),
  rows: Type.Integer({ minimum: 0 }),
});
export type ProjectDataTable = Static<typeof ProjectDataTableSchema>;
const TableName = Type.String({ minLength: 1, maxLength: 4096 });

export const projectDataMethods = {
  "projectData.tables": {
    params: object({ projectId: Id }),
    result: object({
      tables: Type.Array(ProjectDataTableSchema),
      /** The file's size, and the size at which writes stop. */
      bytes: Type.Integer({ minimum: 0 }),
      limitBytes: Type.Integer({ minimum: 0 }),
    }),
  },
  "projectData.rows": {
    params: object({
      projectId: Id,
      table: TableName,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: object({
      columns: Type.Array(Text),
      rows: Type.Array(Type.Array(ProjectDataCellSchema)),
      total: Type.Integer({ minimum: 0 }),
    }),
  },
  /** The whole table as CSV, cut off at 20 MB. */
  "projectData.csv": {
    params: object({ projectId: Id, table: TableName }),
    result: object({ csv: Text, truncated: Type.Boolean() }),
  },
};
/** The file lives on the Mac. */
export const projectDataMacOnlyMethods = [
  "projectData.tables",
  "projectData.rows",
  "projectData.csv",
] as const;
