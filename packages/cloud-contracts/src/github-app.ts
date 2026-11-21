// I8: the cloud exchanges the Zoltbot GitHub App's key for a short-lived installation token,
// scoped to one repository. The daemon asks through the signed-in account; the key never leaves
// the cloud, and the token never leaves the daemon process.

export const githubInstallationTokenPath = "/api/github/installation-token";

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export interface InstallationTokenRequest {
  /** `owner/name`. */
  repo: string;
  /** Known from an earlier answer; the cloud looks it up when absent. */
  installationId?: number;
}
export type InstallationTokenResponse =
  | { installed: true; installationId: number; token: string; expiresAt: string }
  | { installed: false };

export function installationTokenRequest(repo: string, installationId?: number) {
  if (!REPOSITORY.test(repo) || repo.split("/").some((part) => /^\.+$/.test(part)))
    throw new Error("github_repository_invalid");
  return { repo, ...(installationId ? { installationId } : {}) } satisfies InstallationTokenRequest;
}

/** Accepts only an installation token (`ghs_…`) that hasn't expired. */
export function parseInstallationToken(
  value: unknown,
  now = Date.now(),
): InstallationTokenResponse {
  const row = (value ?? {}) as Record<string, unknown>;
  if (row.installed === false) return { installed: false };
  const expires = typeof row.expiresAt === "string" ? Date.parse(row.expiresAt) : Number.NaN;
  if (
    row.installed !== true ||
    typeof row.token !== "string" ||
    !/^ghs_[A-Za-z0-9]{20,255}$/.test(row.token) ||
    !Number.isSafeInteger(row.installationId) ||
    (row.installationId as number) <= 0 ||
    !Number.isFinite(expires) ||
    expires <= now
  )
    throw new Error("github_installation_token_invalid");
  return {
    installed: true,
    installationId: row.installationId as number,
    token: row.token,
    expiresAt: new Date(expires).toISOString(),
  };
}
