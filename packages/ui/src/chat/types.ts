import type { ConnectionState } from "../connection.js";
export type Row = Record<string, unknown>;
export type ChatConnection = ConnectionState & {
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
};
export const body = (row: Row): Row =>
  row.body && typeof row.body === "object" && !Array.isArray(row.body) ? (row.body as Row) : {};
export const text = (value: unknown) => (typeof value === "string" ? value : "");
