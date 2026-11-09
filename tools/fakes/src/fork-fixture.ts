import { type EntityKind, ProfileSchema, parse } from "@zoltbot/protocol";
import { composeLaunchManifest } from "../../../packages/connections/src/launch-manifest.js";
import { ForkFakeSession } from "./fork-runtime.js";
import { at, runtimeFixture } from "./runtime-fixture.js";
export async function forkFixture(databaseName = "store.db") {
  const f = await runtimeFixture(databaseName);
  let seq = 0;
  function put(kind: EntityKind, value: Record<string, unknown>) {
    if (kind === "item") value.updatedAt = at;
    const commandId = `put:${++seq}`;
    f.store.dispatch(commandId, (state) => ({
      events: [
        {
          eventId: commandId,
          aggregateType: kind,
          aggregateId: String(value.id ?? value.key),
          type: `${kind}.${state[kind]?.some((r) => (r.id ?? r.key) === (value.id ?? value.key)) ? "updated" : "created"}` as import("@zoltbot/protocol").DomainEvent["type"],
          occurredAt: at,
          payload: value,
        },
      ],
      result: value,
    }));
  }
  const profile = parse(ProfileSchema, f.store.record("agent", "profile"));
  const manifest = composeLaunchManifest(
    {
      executionId: "thread",
      threadId: "thread",
      profileId: profile.id,
      cwd: f.root,
      configurationHash: "fixture",
    },
    { knowledge: { packId: "knowledge", text: "INHERITED_KNOWLEDGE", tokens: 1 } },
    { limit: 1500, fixed: 0 },
  );
  put("session", {
    ...f.store.record("session", "session"),
    nativeId: "parent-native",
    state: "ready",
    capabilities: new ForkFakeSession("caps").capabilities,
  });
  put("turn", {
    id: "source-turn",
    threadId: "thread",
    sessionId: "session",
    nativeTurnId: "native-turn",
    status: "completed",
    origin: "human",
    startedAt: at,
    endedAt: at,
  });
  put("item", {
    id: "source-message",
    threadId: "thread",
    turnId: "source-turn",
    seq: 1,
    kind: "message",
    body: { text: "SOURCE_ONLY" },
    createdAt: at,
  });
  put("settings", {
    key: "runtime.configuration.session",
    value: { version: 1, profile, workspaceInstructions: "", launchManifest: manifest },
  });
  return { ...f, put };
}
