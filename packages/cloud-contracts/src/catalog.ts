/** Shared nonsecret registration contract. Never put OAuth application secrets in this catalog. */
export const brokerServices = {
  github: {
    name: "GitHub",
    origin: "https://api.githubcopilot.com",
    resource: "https://api.githubcopilot.com/mcp/readonly",
    authorization: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:org"],
    registration: "github",
    permissions: "Read-only MCP tools; OAuth repo permission is broader",
    description: "Repository, issue and pull request context.",
    documentation: "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
  },
  gmail: {
    name: "Gmail",
    origin: "https://gmail.googleapis.com",
    resource: "https://gmail.googleapis.com/gmail/v1",
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    registration: "google",
    permissions: "Read your mailbox",
    description: "Search messages and read email threads.",
    documentation: "https://developers.google.com/workspace/guides/get-started",
  },
  google_drive: {
    name: "Google Drive",
    origin: "https://www.googleapis.com",
    resource: "https://www.googleapis.com/drive/v3",
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    registration: "google",
    permissions: "Read files across your authorized Drive",
    description: "Find files and read documents in Google Drive.",
    documentation: "https://developers.google.com/workspace/guides/get-started",
  },
  google_docs: {
    name: "Google Docs",
    origin: "https://docs.googleapis.com",
    resource: "https://docs.googleapis.com/v1",
    authorization: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
    ],
    registration: "google",
    permissions: "Read documents and discover files",
    description: "Read Google Docs with their document structure.",
    documentation: "https://developers.google.com/workspace/guides/get-started",
  },
  slack: {
    name: "Slack",
    origin: "https://mcp.slack.com",
    resource: "https://mcp.slack.com/mcp",
    authorization: "https://slack.com/oauth/v2_user/authorize",
    token: "https://slack.com/api/oauth.v2.user.access",
    scopes: [
      "search:read.public",
      "search:read.private",
      "search:read.im",
      "search:read.mpim",
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "im:history",
      "mpim:read",
      "mpim:history",
      "users:read",
    ],
    registration: "slack",
    permissions: "Search and read accessible Slack conversations",
    description: "Search conversations and read channel threads.",
    documentation: "https://docs.slack.dev/ai/slack-mcp-server/",
  },
} as const;
export type BrokerServiceId = keyof typeof brokerServices;
export function isBrokerService(value: string): value is BrokerServiceId {
  return Object.hasOwn(brokerServices, value);
}
export const integrationPath = "/api/account/integrations";
export const desktopClientId = "zoltbot-desktop";

export type GoogleServiceId = "gmail" | "google_drive" | "google_docs";
export function googleServiceForResource(resource: string): GoogleServiceId | undefined {
  return (["gmail", "google_drive", "google_docs"] as const).find(
    (id) => brokerServices[id].resource === resource,
  );
}

/** Unverified Google services are visible only to an operator-started test daemon. */
export function availableBrokerServices(
  value: Record<string, unknown>,
  googleTesting = false,
): string[] {
  const services = Array.isArray(value.services)
    ? value.services.filter((id): id is string => typeof id === "string")
    : [];
  if (googleTesting && Array.isArray(value.testServices))
    services.push(
      ...value.testServices.filter((id): id is string =>
        ["gmail", "google_drive", "google_docs"].includes(String(id)),
      ),
    );
  return services;
}
