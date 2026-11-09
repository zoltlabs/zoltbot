export const browserCapabilityErrors = [
  "browser_setup_required",
  "browser_requires_shell_workspace_write_profile",
  "browser_provider_unverified",
  "browser_version_unsupported",
  "browser_materialization_changed",
  "browser_guidance_changed",
  "browser_directory_not_owned",
  "browser_artifact_root_symlink_denied",
] as const;
export const browserHoldReasons: Readonly<Record<string, string>> = {
  browser_setup_required:
    "Browser setup required. Open Settings → Browser and set up the local browser, then this task can start.",
  browser_requires_shell_workspace_write_profile:
    "This profile cannot execute browser shell commands. Explicitly choose a workspace-write profile for a new task.",
  browser_provider_unverified:
    "This profile has no verified local-browser CLI support. Choose a supported profile for a new task.",
  browser_version_unsupported:
    "The frozen browser runtime version is unavailable. Repair browser setup or start a fresh task.",
  browser_materialization_changed:
    "The frozen browser launcher changed. Inspect the generated files and start a fresh task.",
  browser_guidance_changed:
    "The frozen browser guidance failed its integrity check. Start a fresh task.",
  browser_directory_not_owned:
    "The browser output location is not an owned regular directory. Choose a safe task folder.",
  browser_artifact_root_symlink_denied:
    "The browser output location contains a symlink. Choose a regular task folder.",
};
