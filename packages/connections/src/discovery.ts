import { checkedDestination, type DestinationPolicy, requestJson } from "./network.js";

/** Discovery never grants access to an origin not explicitly approved by the human. */
export async function discoverAuthorization(
  resource: string,
  policy: DestinationPolicy,
  metadataUrl?: string,
) {
  const server = new URL(resource);
  const paths = metadataUrl
    ? [metadataUrl]
    : [
        `${server.origin}/.well-known/oauth-protected-resource${server.pathname === "/" ? "" : server.pathname}`,
        `${server.origin}/.well-known/oauth-protected-resource`,
      ];
  let metadata: Record<string, unknown> | undefined;
  for (const url of [...new Set(paths)]) {
    try {
      metadata = await requestJson(url, policy);
      break;
    } catch {
      /* Try the next standard discovery location. */
    }
  }
  if (
    !metadata ||
    metadata.resource !== resource ||
    !Array.isArray(metadata.authorization_servers) ||
    !metadata.authorization_servers.length ||
    typeof metadata.authorization_servers[0] !== "string"
  )
    throw new Error("oauth_resource_metadata_invalid");
  const issuer = new URL(metadata.authorization_servers[0]);
  await checkedDestination(issuer.toString(), policy);
  const suffix = issuer.pathname === "/" ? "" : issuer.pathname;
  const endpoints = [
    `${issuer.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${issuer.origin}/.well-known/openid-configuration${suffix}`,
    ...(suffix ? [`${issuer.origin}${suffix}/.well-known/openid-configuration`] : []),
  ];
  for (const endpoint of endpoints) {
    try {
      const config = await requestJson(endpoint, policy);
      if (
        config.issuer !== metadata.authorization_servers[0] ||
        typeof config.authorization_endpoint !== "string" ||
        typeof config.token_endpoint !== "string" ||
        !Array.isArray(config.code_challenge_methods_supported) ||
        !config.code_challenge_methods_supported.includes("S256")
      )
        continue;
      await checkedDestination(config.authorization_endpoint, policy);
      await checkedDestination(config.token_endpoint, policy);
      return {
        issuer: String(config.issuer),
        authorizationEndpoint: config.authorization_endpoint,
        tokenEndpoint: config.token_endpoint,
        registrationRequired: true as const,
      };
    } catch {
      /* No error bodies enter diagnostics. */
    }
  }
  throw new Error("oauth_authorization_metadata_invalid");
}
