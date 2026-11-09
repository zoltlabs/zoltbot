import { createContext, type ReactNode } from "react";
import type { Row } from "../types.js";

/** Subagent rows by parent item id, and how the timeline renders one of them. */
export interface NestedRows {
  nested: Map<string, Row[]>;
  render(row: Row): ReactNode;
}
export const NestedRowsContext = createContext<NestedRows>({
  nested: new Map(),
  render: () => null,
});
