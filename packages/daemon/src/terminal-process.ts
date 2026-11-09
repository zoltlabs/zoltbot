import { execFileSync } from "node:child_process";

interface Process {
  pid: number;
  parent: number;
  group: number;
  started: string;
}
function processes(): Process[] {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 4 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        return match
          ? [
              {
                pid: Number(match[1]),
                parent: Number(match[2]),
                group: Number(match[3]),
                started: String(match[4]),
              },
            ]
          : [];
      });
  } catch {
    return [];
  }
}
/** Capture descendants before the shell exits; don't signal reused process groups on escalation. */
export function terminalProcessGroups(pid: number) {
  const table = processes(),
    owned = new Set([pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const row of table)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const ownGroup = table.find((row) => row.pid === process.pid)?.group;
  const members = table.filter(
    (row) => owned.has(row.pid) && row.group > 1 && row.group !== ownGroup,
  );
  return (signal: "SIGTERM" | "SIGKILL") => {
    const current = signal === "SIGTERM" ? table : processes();
    const groups = new Set(
      members
        .filter((member) =>
          current.some(
            (row) =>
              row.pid === member.pid &&
              row.group === member.group &&
              row.started === member.started,
          ),
        )
        .map((row) => row.group),
    );
    for (const group of groups) {
      try {
        process.kill(-group, signal);
      } catch {}
    }
    return groups.size > 0;
  };
}
