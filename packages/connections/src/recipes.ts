import { checkedDestination, requestJson } from "./network.js";
import type { OAuthConfiguration } from "./oauth.js";
import {
  availableBrokerServices,
  brokerOrigin,
  brokerServices,
  desktopClientId,
  integrationPath,
  isBrokerService,
} from "./service-catalog.js";

/**
 * Services that sign in directly with the vendor's MCP server, registering Zoltbot on the fly
 * (dynamic client registration). Metadata is read from `metadata`, and every endpoint it names must
 * stay on `origins`.
 */
const direct = {
  linear: {
    resource: "https://mcp.linear.app/mcp",
    issuer: "https://mcp.linear.app",
    origins: ["https://mcp.linear.app"],
    scopes: ["read"],
    issuerParameter: true,
  },
  posthog: {
    resource: "https://mcp.posthog.com/mcp",
    issuer: "https://oauth.posthog.com",
    origins: ["https://mcp.posthog.com", "https://oauth.posthog.com"],
    authorizationResource: "https://mcp.posthog.com",
    scopes: [
      "organization:read",
      "project:read",
      "user:read",
      "query:read",
      "insight:read",
      "dashboard:read",
      "feature_flag:read",
      "event_definition:read",
      "error_tracking:read",
      "experiment:read",
    ],
    issuerParameter: false,
  },
  sentry: {
    // Built per Sentry project in recipeResource.
    resource: "",
    issuer: "https://mcp.sentry.dev",
    origins: ["https://mcp.sentry.dev"],
    scopes: ["org:read", "project:write", "team:write", "event:write", "alerts:write"],
    issuerParameter: true,
  },
  // I7: one-click sign-in without a Zoltbot registration.
  notion: {
    resource: "https://mcp.notion.com/mcp",
    issuer: "https://mcp.notion.com",
    origins: ["https://mcp.notion.com"],
    scopes: ["default"],
    issuerParameter: true,
  },
  atlassian: {
    resource: "https://mcp.atlassian.com/v1/mcp",
    issuer: "https://mcp.atlassian.com",
    origins: ["https://mcp.atlassian.com"],
    // Atlassian lists no scopes; access follows the sites the owner picks while signing in.
    scopes: [],
    issuerParameter: false,
  },
  airtable: {
    resource: "https://mcp.airtable.com/mcp",
    issuer: "https://airtable.com/oauth2/v1",
    // Airtable publishes its server metadata on the MCP host, for an issuer on airtable.com.
    metadata: "https://mcp.airtable.com/.well-known/oauth-authorization-server",
    origins: ["https://mcp.airtable.com", "https://airtable.com"],
    scopes: ["data.records:read", "schema.bases:read", "workspacesAndBases:read"],
    issuerParameter: false,
  },
} as const satisfies Record<
  string,
  {
    resource: string;
    issuer: string;
    metadata?: string;
    origins: readonly string[];
    authorizationResource?: string;
    scopes: readonly string[];
    issuerParameter: boolean;
  }
>;
type DirectServiceId = keyof typeof direct;
export type ServiceId = DirectServiceId | keyof typeof brokerServices;
export const connectionRecipes = [
  {
    id: "linear" as const,
    name: "Linear",
    description: "Issues, project updates and the context behind your next task.",
    origin: "https://mcp.linear.app",
    documentation: "https://linear.app/docs/mcp",
    permissions: "Read only",
  },
  {
    id: "sentry" as const,
    name: "Sentry",
    description: "Stack traces, error details and performance context for debugging.",
    origin: "https://mcp.sentry.dev",
    documentation: "https://mcp.sentry.dev/",
    permissions: "Capabilities approved in Sentry",
  },
  {
    id: "posthog" as const,
    name: "PostHog",
    description: "Analytics, funnels and product context.",
    origin: "https://mcp.posthog.com",
    documentation: "https://posthog.com/docs/model-context-protocol",
    permissions: "Read-only MCP tools",
  },
  {
    id: "notion" as const,
    name: "Notion",
    description: "Pages, databases and docs from your Notion workspace.",
    origin: "https://mcp.notion.com",
    documentation: "https://developers.notion.com/docs/mcp",
    permissions: "Notion’s MCP tools, which can read and edit pages",
  },
  {
    id: "atlassian" as const,
    name: "Jira",
    description: "Jira issues and Confluence pages from your Atlassian sites.",
    origin: "https://mcp.atlassian.com",
    documentation: "https://support.atlassian.com/atlassian-rovo-mcp-server/",
    permissions: "Access follows the sites you approve at Atlassian",
  },
  {
    id: "airtable" as const,
    name: "Airtable",
    description: "Records and schemas from your Airtable bases.",
    origin: "https://mcp.airtable.com",
    documentation: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    permissions: "Read records and base schemas",
  },
  ...Object.entries(brokerServices).map(([id, entry]) => ({
    id: id as keyof typeof brokerServices,
    name: entry.name,
    description: entry.description,
    origin: entry.origin,
    documentation: entry.documentation,
    permissions: entry.permissions,
  })),
];
export function recipeResource(serviceId: ServiceId, organization?: string, project?: string) {
  if (isBrokerService(serviceId)) return brokerServices[serviceId].resource;
  if (serviceId !== "sentry") {
    if (!Object.hasOwn(direct, serviceId)) throw new Error("connection_service_unsupported");
    return direct[serviceId as DirectServiceId].resource;
  }
  const slug = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
  if (!organization || !project || !slug.test(organization) || !slug.test(project))
    throw new Error("connection_sentry_project_required");
  return `https://mcp.sentry.dev/mcp/${organization}/${project}`;
}
/** App-owned origins and exact resource patterns; renderer cannot supply OAuth destinations. */
export async function recipeAuthorization(
  serviceId: ServiceId,
  resource: string,
  identity: string,
): Promise<OAuthConfiguration> {
  const recipe = connectionRecipes.find((entry) => entry.id === serviceId);
  if (!recipe) throw new Error("connection_service_unsupported");
  const parts = new URL(resource).pathname.split("/");
  if (resource !== recipeResource(serviceId, parts[2], parts[3]))
    throw new Error("connection_recipe_resource_mismatch");
  if (isBrokerService(serviceId)) {
    const origin = brokerOrigin();
    const status = await requestJson(`${origin}${integrationPath}/catalog`, { origins: [origin] });
    if (
      !availableBrokerServices(status, process.env.ZOLTBOT_GOOGLE_TEST_MODE === "1").includes(
        serviceId,
      )
    )
      throw new Error("connection_registration_pending");
    return {
      identity,
      resource,
      issuer: origin,
      policy: { origins: [origin, recipe.origin] },
      clientId: desktopClientId,
      authorizationEndpoint: `${origin}${integrationPath}/${serviceId}/authorize`,
      tokenEndpoint: `${origin}${integrationPath}/${serviceId}/token`,
      scopes: [...brokerServices[serviceId].scopes],
    };
  }
  const service = direct[serviceId as DirectServiceId];
  const { issuer } = service;
  const policy = { origins: [...service.origins] };
  const metadata = await requestJson(
    "metadata" in service ? service.metadata : `${issuer}/.well-known/oauth-authorization-server`,
    policy,
  );
  if (
    metadata.issuer !== issuer ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    typeof metadata.registration_endpoint !== "string" ||
    (service.issuerParameter && metadata.authorization_response_iss_parameter_supported !== true) ||
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256") ||
    !Array.isArray(metadata.token_endpoint_auth_methods_supported) ||
    !metadata.token_endpoint_auth_methods_supported.includes("none")
  )
    throw new Error("connection_service_auth_unsupported");
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ])
    await checkedDestination(endpoint, policy);
  const supported = metadata.scopes_supported;
  const scopes: string[] = [...service.scopes];
  if (scopes.length && (!Array.isArray(supported) || scopes.some((s) => !supported.includes(s))))
    throw new Error("connection_service_scopes_changed");
  return {
    identity,
    resource,
    issuer,
    ...("authorizationResource" in service
      ? { authorizationResource: service.authorizationResource }
      : {}),
    ...(service.issuerParameter ? {} : { issuerParameterRequired: false }),
    policy,
    clientId: "",
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    scopes,
  };
}
