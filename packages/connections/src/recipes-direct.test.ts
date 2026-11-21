import { beforeEach, describe, expect, it, vi } from "vitest";

const metadata = new Map<string, Record<string, unknown>>();
vi.mock("./network.js", () => ({
  requestJson: vi.fn(async (url: string, policy: { origins: string[] }) => {
    if (!policy.origins.includes(new URL(url).origin))
      throw new Error("connection_destination_denied");
    const value = metadata.get(url);
    if (!value) throw new Error("not_found");
    return value;
  }),
  checkedDestination: vi.fn(async (url: string, policy: { origins: string[] }) => {
    if (!policy.origins.includes(new URL(url).origin))
      throw new Error("connection_destination_denied");
    return { url: new URL(url), address: { address: "203.0.113.1", family: 4 } };
  }),
}));
const { recipeAuthorization, recipeResource } = await import("./recipes.js");

const server = (issuer: string, base: string, extra: Record<string, unknown> = {}) => ({
  issuer,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  registration_endpoint: `${base}/register`,
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  ...extra,
});

describe("one-click sign-in apps (I7)", () => {
  beforeEach(() => metadata.clear());

  it("signs Notion in with its own registration and the iss check", async () => {
    metadata.set(
      "https://mcp.notion.com/.well-known/oauth-authorization-server",
      server("https://mcp.notion.com", "https://mcp.notion.com", {
        scopes_supported: ["default"],
        authorization_response_iss_parameter_supported: true,
      }),
    );
    const config = await recipeAuthorization("notion", recipeResource("notion"), "id");
    expect(config).toMatchObject({
      resource: "https://mcp.notion.com/mcp",
      scopes: ["default"],
      clientId: "",
      registrationEndpoint: "https://mcp.notion.com/register",
    });
    expect(config.issuerParameterRequired).toBeUndefined();
  });

  it("reads Airtable's metadata from the MCP host and keeps its endpoints on airtable.com", async () => {
    metadata.set(
      "https://mcp.airtable.com/.well-known/oauth-authorization-server",
      server("https://airtable.com/oauth2/v1", "https://airtable.com/oauth2/v1", {
        scopes_supported: ["data.records:read", "schema.bases:read", "workspacesAndBases:read"],
      }),
    );
    const config = await recipeAuthorization("airtable", recipeResource("airtable"), "id");
    expect(config).toMatchObject({
      issuer: "https://airtable.com/oauth2/v1",
      issuerParameterRequired: false,
      policy: { origins: ["https://mcp.airtable.com", "https://airtable.com"] },
      scopes: ["data.records:read", "schema.bases:read", "workspacesAndBases:read"],
    });
    // An endpoint off the allowed origins is refused.
    metadata.set(
      "https://mcp.airtable.com/.well-known/oauth-authorization-server",
      server("https://airtable.com/oauth2/v1", "https://evil.example", {
        scopes_supported: ["data.records:read", "schema.bases:read", "workspacesAndBases:read"],
      }),
    );
    await expect(recipeAuthorization("airtable", recipeResource("airtable"), "id")).rejects.toThrow(
      "destination_denied",
    );
  });

  it("asks Atlassian for no scopes and refuses a server that changed its issuer", async () => {
    metadata.set(
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server",
      server("https://mcp.atlassian.com", "https://mcp.atlassian.com/v1"),
    );
    expect(await recipeAuthorization("atlassian", recipeResource("atlassian"), "id")).toMatchObject(
      { resource: "https://mcp.atlassian.com/v1/mcp", scopes: [] },
    );
    metadata.set(
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server",
      server("https://other.example", "https://mcp.atlassian.com/v1"),
    );
    await expect(
      recipeAuthorization("atlassian", recipeResource("atlassian"), "id"),
    ).rejects.toThrow("auth_unsupported");
    await expect(
      recipeAuthorization("notion", "https://mcp.notion.com/other", "id"),
    ).rejects.toThrow("resource_mismatch");
  });
});
