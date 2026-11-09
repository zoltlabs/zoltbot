import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { manifestRuntimeFile } from "./connections-runtime-file.js";

export interface RuntimeFile {
  path: string;
  dispose(): Promise<void>;
}

/** Per-host artifacts. Call close only after all native processes have stopped. */
export class RuntimeFiles {
  private readonly directories = new Set<string>();
  private closed = false;
  constructor(private readonly root: string) {}

  async config(content: unknown, manifestId?: string): Promise<RuntimeFile> {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(content);
    } catch {
      throw new Error("invalid_runtime_config");
    }
    if (encoded === undefined) throw new Error("invalid_runtime_config");
    if (manifestId) {
      if (this.closed) throw new Error("runtime_files_closed");
      if (Buffer.byteLength(encoded) > 1048576) throw new Error("runtime_file_too_large");
      const file = manifestRuntimeFile(this.root, manifestId, encoded);
      this.directories.add(path.dirname(file.path));
      return {
        path: file.path,
        dispose: async () => {
          await file.dispose();
          this.directories.delete(path.dirname(file.path));
        },
      };
    }
    return this.create("config.json", encoded);
  }

  async extension(source: string, sha256: string): Promise<RuntimeFile> {
    if (createHash("sha256").update(source).digest("hex") !== sha256)
      throw new Error("extension_hash_mismatch");
    return this.create("extension.ts", source);
  }

  private create(name: string, content: string): RuntimeFile {
    if (this.closed) throw new Error("runtime_files_closed");
    if (Buffer.byteLength(content) > 1048576) throw new Error("runtime_file_too_large");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(path.join(this.root, "native-"));
    const file = path.join(directory, name);
    try {
      writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    } catch {
      rmSync(directory, { recursive: true, force: true });
      throw new Error("runtime_file_write_failed");
    }
    this.directories.add(directory);
    return {
      path: file,
      dispose: async () => {
        rmSync(directory, { recursive: true, force: true });
        this.directories.delete(directory);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const directory of this.directories) {
      rmSync(directory, { recursive: true, force: true });
      this.directories.delete(directory);
    }
  }
}
