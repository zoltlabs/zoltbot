const services: Record<string, string> = {
  linear: "Linear",
  sentry: "Sentry",
  github: "GitHub",
  posthog: "PostHog",
  gmail: "Gmail",
  google_drive: "Google Drive",
  google_docs: "Google Docs",
  slack: "Slack",
};
export function serviceName(source: string): string | undefined {
  const match = /^catalog:([a-z_]+):v1$/.exec(source);
  return match?.[1] ? services[match[1]] : undefined;
}
export function usesBroker(id: string) {
  return ["github", "gmail", "google_drive", "google_docs", "slack"].includes(id);
}
export function serviceMark(id: string) {
  return (
    (
      {
        linear: "◒",
        sentry: "△",
        github: "GH",
        posthog: "PH",
        gmail: "M",
        google_drive: "D",
        google_docs: "▤",
        slack: "#",
      } as Record<string, string>
    )[id] ?? "◇"
  );
}
export function permissionDescription(id: string) {
  return (
    (
      {
        linear:
          "Requests only the read permission. Access follows the workspace you authorize in Linear.",
        sentry:
          "Sentry requests org:read, project:write, team:write, event:write and alerts:write. Review capabilities in Sentry; this is not a read-only grant.",
        github:
          "GitHub MCP exposes read-only tools. The OAuth repo scope itself also permits repository writes; repository choices are governed by your GitHub grant, not this app’s workspace setting. Existing gh shipping authentication is separate.",
        posthog:
          "Requests analytics read scopes and read-only MCP tools. This project is pinned for MCP requests. Provider usage charges and AI processing settings still apply.",
        gmail:
          "Reads and searches the mailbox you authorize. No send, draft or modify scope is requested. Labels and search terms do not restrict mailbox authorization.",
        google_drive:
          "Reads files across the Drive account you authorize. This is broad read access, not selected-file or folder-only access.",
        google_docs:
          "Reads Google Docs and discovers files in the Drive account you authorize. This is not selected-document authorization and does not permit editing.",
        slack:
          "Searches accessible public/private conversations and reads their history. No chat:write permission is requested. Channel choices do not restrict the workspace grant. Organization approval may be required.",
      } as Record<string, string>
    )[id] ?? "Review the requested permissions at the service."
  );
}
export function connectionError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : "";
  if (message.includes("google_reconnect_required"))
    return "Reconnect this Google service to use the stable API adapter.";
  if (message.includes("registration_pending"))
    return "Zoltbot’s service registration is not enabled yet. No credential was attached. Registration setup must be completed before browser sign-in is available.";
  if (message.includes("posthog_project"))
    return "Enter the numeric PostHog project ID from your project settings.";
  if (message.includes("keychain"))
    return "Your Mac Keychain is unavailable. Unlock it and try again. No plaintext credential is stored.";
  if (message.includes("sentry_project"))
    return "Enter valid Sentry organization and project slugs.";
  if (message.includes("version_conflict"))
    return "This connection changed. Close this setup and reopen its current details before saving access.";
  if (message.includes("scope_denied"))
    return "The workspace or profile is no longer available. Review your selection.";
  if (message.includes("auth_unsupported") || message.includes("scopes_changed"))
    return "The service’s sign-in requirements changed. This connection cannot be authorized safely. Try again after updating Zoltbot.";
  if (message.includes("health_failed"))
    return "The service did not complete the protocol check. Sign-in is preserved. Check your network and service permissions, then retry.";
  return "The connection could not be completed. Your setup is preserved. Check your network, then try again.";
}

export function supportsManagedConnection(definitionId: unknown): boolean {
  return definitionId === "claude" || definitionId === "codex";
}

export const sentrySlugPattern = String.raw`[a-zA-Z0-9][a-zA-Z0-9_\-]{0,99}`;
