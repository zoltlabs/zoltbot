import { randomUUID } from "node:crypto";
import path from "node:path";
import { Logger, type Redactor } from "./logging.js";
import { Supervisor } from "./supervisor.js";
import { supervisedTransport } from "./transport.js";

export interface NativeLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
type NativeTransport = ReturnType<typeof supervisedTransport>;

/** Process ownership shared by adapter hosts. Protocol and provider flags stay in adapters. */
export class NativeProcesses {
  private readonly connections = new Set<NativeTransport>();
  private closing: Promise<void> | undefined;
  constructor(private readonly directory: string) {}

  connect(launch: NativeLaunch, redactor: Redactor): NativeTransport {
    if (this.closing) throw new Error("native_processes_closed");
    const id = randomUUID();
    const supervisor = new Supervisor(
      {
        ...launch,
        frameFile: path.join(this.directory, `${id}.frames.jsonl`),
        frameLimitBytes: 2_000_000,
      },
      new Logger(path.join(this.directory, `${id}.log.jsonl`), redactor),
    );
    const transport = supervisedTransport(supervisor);
    this.connections.add(transport);
    // A dead stream cannot serve a replacement process. SessionManager owns recovery.
    void transport.closed.then(async () => {
      await transport.close();
      this.connections.delete(transport);
    });
    return transport;
  }

  close(): Promise<void> {
    this.closing ??= Promise.all(
      [...this.connections].map((connection) => connection.close()),
    ).then(() => {
      this.connections.clear();
    });
    return this.closing;
  }
}
