import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Logger, Redactor, Supervisor } from "@zoltbot/daemon";

export interface CaptureOptions {
  command: string;
  args: string[];
  cwd: string;
  version: string;
  output: string;
  secrets?: string[];
  env?: Record<string, string>;
  personalRoots?: string[];
}
export function record(options: CaptureOptions) {
  const redactor = new Redactor(options.secrets);
  mkdirSync(path.dirname(options.output), { recursive: true, mode: 0o700 });
  const normalize = (value: string) => {
    let text = redactor.text(value);
    for (const root of [options.cwd, ...(options.personalRoots ?? [])])
      text = text.split(root).join("/work/repo");
    return text.replace(/\/Users\/[^/\s"']+/g, "/home/user");
  };
  const write = (direction: "metadata" | "stdin" | "stdout" | "stderr", frame: unknown) => {
    const body = typeof frame === "string" ? frame : JSON.stringify(redactor.value(frame));
    appendFileSync(options.output, `${JSON.stringify({ direction, frame: normalize(body) })}\n`, {
      mode: 0o600,
    });
  };
  write("metadata", {
    version: options.version,
    command: options.command,
    args: options.args.map((arg, index) =>
      ["-e", "--eval"].includes(options.args[index - 1] ?? "") ? "[inline program]" : arg,
    ),
  });
  const logger = new Logger(path.join(options.cwd, "recorder.log"), redactor);
  const provider = new Supervisor(
    {
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      frameFile: path.join(options.cwd, "recorder-frames.jsonl"),
    },
    logger,
  );
  provider.on("stdout", (line: string) => {
    let value: unknown = line;
    try {
      value = JSON.parse(line);
    } catch {}
    write("stdout", value);
  });
  provider.on("stderr", (line: string) => write("stderr", line));
  provider.start();
  return {
    provider,
    send(frame: unknown) {
      write("stdin", frame);
      provider.write(JSON.stringify(frame));
    },
    close: () => provider.close(),
  };
}
