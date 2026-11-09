import { randomUUID } from "node:crypto";
import { SessionTokens, startHostMcp, ToolDispatcher } from "@zoltbot/hostmcp";
import { callGoogleTool, googleTools } from "../../connections/src/google-api.js";
import type { ConnectionDescriptor } from "../../connections/src/launch-manifest.js";
import type { NativeConnection } from "../../connections/src/materialize.js";
import type { OAuthCredential } from "../../connections/src/oauth.js";
import { googleServiceForResource } from "../../connections/src/service-catalog.js";

/** One capability per frozen connection/launch. Google bearer tokens never leave the daemon. */
export async function startGoogleAdapter(
  descriptor: ConnectionDescriptor,
  read: () => Promise<OAuthCredential>,
  assertUsable: () => void,
  remember: (secret: string) => void,
) {
  if (descriptor.transport.kind !== "https") throw new Error("google_resource_invalid");
  const service = googleServiceForResource(descriptor.transport.url);
  if (!service) throw new Error("google_resource_invalid");
  const definitions = googleTools(service);
  const tokens = new SessionTokens();
  const capability = tokens.issue({
    agentId: descriptor.id,
    threadId: descriptor.projectId,
    sessionId: randomUUID(),
  });
  remember(capability);
  const dispatcher = new ToolDispatcher(tokens, {
    tools: new Map(
      definitions.map((tool) => [
        tool.name,
        async (call) => {
          assertUsable();
          const credential = await read();
          assertUsable();
          const result = await callGoogleTool(
            service,
            tool.name,
            call.arguments as Record<string, unknown>,
            credential.accessToken,
          );
          assertUsable();
          return result;
        },
      ]),
    ),
    authorize: () => {
      try {
        assertUsable();
        return true;
      } catch {
        return false;
      }
    },
    checkLimits: (() => {
      let window = Date.now(),
        count = 0;
      return () => {
        if (Date.now() - window >= 60000) {
          window = Date.now();
          count = 0;
        }
        return ++count <= 60;
      };
    })(),
    audit: async () => {}, // Never persist message/file contents, arguments or bearer credentials.
  });
  const server = await startHostMcp({ tokens, dispatcher, tools: definitions });
  const connection: NativeConnection = {
    name: descriptor.name,
    kind: "https",
    url: server.url,
    headers: { Authorization: `Bearer ${capability}` },
    local: true,
  };
  return { connection, close: () => server.close() };
}
