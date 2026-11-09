import semver from "semver";
export type SupportStatus = "tested" | "newer" | "older" | "unsupported" | "unknown";
export function versionFromOutput(output: string): string | undefined {
  const match = output.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\b/)?.[0];
  // Date based releases such as Cursor's 2026.11.05 pad with zeros that semver rejects.
  const version = match?.replace(/^(\d+)\.(\d+)\.(\d+)/, (_, ...parts: string[]) =>
    parts
      .slice(0, 3)
      .map((part) => String(Number(part)))
      .join("."),
  );
  return version && semver.valid(version) ? version : undefined;
}
/** True when a provider's published release is newer than the installed one. */
export function isNewerRelease(latest: string, installed: string) {
  return semver.gt(latest, installed);
}
export function compareVersions(left: string, right: string) {
  return semver.compare(left, right);
}
export function supportStatus(
  version: string | undefined,
  tested: string,
  blocked: string[] = [],
): SupportStatus {
  if (!version || !semver.valid(version)) return "unknown";
  if (
    blocked.some(
      (range) =>
        semver.validRange(range) && semver.satisfies(version, range, { includePrerelease: true }),
    )
  )
    return "unsupported";
  if (!semver.validRange(tested)) return "unknown";
  if (semver.satisfies(version, tested, { includePrerelease: true })) return "tested";
  if (semver.gtr(version, tested, { includePrerelease: true })) return "newer";
  if (semver.ltr(version, tested, { includePrerelease: true })) return "older";
  return "unsupported";
}
