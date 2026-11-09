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

export type ServiceId = "linear" | "sentry" | "posthog" | keyof typeof brokerServices;
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
  if (serviceId === "posthog") return "https://mcp.posthog.com/mcp";
  if (serviceId === "linear") return "https://mcp.linear.app/mcp";
  if (serviceId !== "sentry") throw new Error("connection_service_unsupported");
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
  const issuer = serviceId === "posthog" ? "https://oauth.posthog.com" : recipe.origin;
  const policy = { origins: [...new Set([recipe.origin, issuer])] };
  const metadata = await requestJson(`${issuer}/.well-known/oauth-authorization-server`, policy);
  if (
    metadata.issuer !== issuer ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    typeof metadata.registration_endpoint !== "string" ||
    (serviceId !== "posthog" && metadata.authorization_response_iss_parameter_supported !== true) ||
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
  const scopes =
    serviceId === "linear"
      ? ["read"]
      : serviceId === "posthog"
        ? [
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
          ]
        : ["org:read", "project:write", "team:write", "event:write", "alerts:write"];
  if (!Array.isArray(supported) || scopes.some((scope) => !supported.includes(scope)))
    throw new Error("connection_service_scopes_changed");
  return {
    identity,
    resource,
    issuer,
    ...(serviceId === "posthog"
      ? { authorizationResource: recipe.origin, issuerParameterRequired: false }
      : {}),
    policy,
    clientId: "",
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint,
    scopes,
  };
}
