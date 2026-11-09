import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/** Readers see either a complete previous receipt or a complete new one, never a truncated token file. */
export function writeConnectionFile(file: string, content: string): void {
  const pending = `${file}.${randomUUID()}.pending`;
  try {
    writeFileSync(pending, content, { mode: 0o600, flag: "wx" });
    renameSync(pending, file);
  } finally {
    rmSync(pending, { force: true });
  }
}
