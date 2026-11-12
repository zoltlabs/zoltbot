import type { Daemon, DaemonOptions, RuntimeContext } from "./api-types.js";
import { companyApi } from "./company-api.js";
import { startCompanySupervisor } from "./company-supervisor.js";

export type {
  Daemon,
  DaemonOptions,
  OwnedRuntime,
  RuntimeContext,
  SetupContext,
} from "./api-types.js";

import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import path from "node:path";
import { type Command, handle } from "@zoltbot/core/commands";
import { pairingOfferTtlMs } from "@zoltbot/link";
import {
  type DomainEvent,
  HOST_WORKSPACE_REF,
  ImportReceiptSchema,
  type Interaction,
  type InteractionAnswer,
  localCommandActor,
  macOnlyMethods,
  methodCatalog,
  parse,
  parseRequest,
  protocolVersion,
} from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
import { WebSocket, WebSocketServer } from "ws";
import { assetServer } from "./api-assets.js";
import { equalToken } from "./api-token.js";
import { artifactsApi } from "./artifacts/api.js";
import { artifactRepositorySync } from "./artifacts/repository-sync.js";
import { browserApi } from "./browser/api.js";
import { frozenBrowser } from "./browser/evidence.js";
import { chiefWaker } from "./chief/proactive.js";
import { compareApi } from "./compare-api.js";
import { writeConnectionFile } from "./connection-file.js";
import { connectionsApi } from "./connections-api.js";
import { conversationServices } from "./conversation-services.js";
import { creationApi } from "./creation-api.js";
import { type Cleanup, withDaemonResources } from "./daemon-resources.js";
import { deviceBook } from "./devices.js";
import { entityEditsApi } from "./entity-edits.js";
import { forkApi } from "./fork-api.js";
import { shippingService } from "./github/service.js";
import { respondHostApproval } from "./host-approvals.js";
import { inboxApi } from "./inbox-api.js";
import { interactionApi } from "./interaction-api.js";
import type { InteractionEngine } from "./interaction-engine.js";
import { knowledgeApi } from "./knowledge-api.js";
import { knowledgeHygieneTimer } from "./knowledge-hygiene.js";
import { taintObserver } from "./knowledge-taint.js";
import { macIdentity } from "./link-identity.js";
import { Logger, Redactor } from "./logging.js";
import { messageApi } from "./message-api.js";
import { nativeApi } from "./native-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { projectFilesApi } from "./project-files.js";
import { pushNotifier } from "./push.js";
import { recover } from "./recovery.js";
import { type LinkClient, type RelayLink, relayLink } from "./relay-link.js";
import { ruleApi } from "./rule-api.js";
import { createInProcessRuntime, publishRuntimeStream, type Runner } from "./runner/index.js";
import { runtimeApi } from "./runtime-api.js";
import type { SessionManager } from "./session-manager.js";
import { settingsApi } from "./settings-api.js";
import { setupApi } from "./setup-api.js";
import { skillsApi } from "./skills-api.js";
import { taskRunner } from "./task-runner.js";
import { TerminalRuntime } from "./terminal-runtime.js";
import { usageApi } from "./usage-api.js";
import { createViewRegistry, type ViewRegistry } from "./views/registry.js";
import { wakeService } from "./wakes.js";
import { listThreadFiles } from "./workspace-files.js";
import { worktreeService } from "./worktree-service.js";

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  return withDaemonResources(options.dataDir, (resources, dispose) =>
    startOwnedDaemon(options, resources, dispose),
  );
}
async function startOwnedDaemon(
  options: DaemonOptions,
  resources: Cleanup[],
  dispose: () => Promise<void>,
): Promise<Daemon> {
  const token = randomBytes(32).toString("hex");
  const redactor = options.redactor ?? new Redactor();
  redactor.register(token);
  const logger = new Logger(path.join(options.dataDir, "daemon.log"), redactor);
  const store = await openStore(path.join(options.dataDir, "zoltbot.db"));
  resources.push(() => store.close());
  const bootId = `boot:${randomBytes(12).toString("hex")}`;
  recover(store, bootId);
  const origins = new Set(options.origins ?? ["zoltbot://desktop"]);
  let views: ViewRegistry | undefined;
  const assets = assetServer(store, token, origins, () => views);
  const server = new WebSocketServer({
    server: assets,
    maxPayload: 1_048_576,
    verifyClient: (info: { origin: string }) => !info.origin || origins.has(info.origin),
  });
  resources.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  assets.listen(0, "127.0.0.1");
  resources.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        assets.closeAllConnections();
        assets.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("invalid listen address");
  const url = `ws://127.0.0.1:${address.port}`;
  const connectionFile = path.join(options.dataDir, "daemon.json");
  resources.push(() => rmSync(connectionFile, { force: true }));
  /** Signed in clients: desktop sockets and paired phones over the relay. */
  const clients = new Set<LinkClient>();
  let closed = false;
  let closing: Promise<void> | undefined;

  let tasks: ReturnType<typeof taskRunner> | undefined;
  let orchestration: ReturnType<typeof conversationServices>["orchestration"] | undefined;
  let observers: ((events: DomainEvent[]) => void) | undefined;
  const publish = (events: DomainEvent[]) => {
    for (const client of clients)
      if (client.subscribed)
        for (const event of events)
          client.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: event }));
    tasks?.observe(events);
    orchestration?.observe(events);
    inbox.observe(events);
    observers?.(events);
  };
  const inbox = inboxApi({
    store,
    publish: (events) => publish(events),
    answer: (method, params, commandId) => interaction(method, params, commandId),
    send: async (method, params, commandId) => {
      const result = await runtime?.(method, params, commandId);
      if (result === undefined) throw new Error("runtime_unavailable");
      return result;
    },
  });
  const messages = messageApi({
    store,
    publish: (events) => publish(events),
    send: async (method, params, commandId) => {
      const result = await runtime?.(method, params, commandId);
      if (result === undefined) throw new Error("runtime_unavailable");
      return result;
    },
  });
  const privacy = new PrivateInputGuard({
    store,
    publish,
    ...(options.secrets ? { secrets: options.secrets } : {}),
  });
  privacy.track(redactor);
  let manager: SessionManager | undefined;
  let runner: Runner | undefined;
  let interactions: InteractionEngine | undefined;
  let loadingInteractions: Promise<InteractionEngine> | undefined;
  const runtimeContext: RuntimeContext = {
    store,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    privacy,
    publish,
    async wake(threadId) {
      if (!runner) throw new Error("runtime_unavailable");
      await runner.startSession({ threadId });
    },
    interrupt(threadId, turnId, commandId) {
      if (!manager) return Promise.reject(new Error("runtime_unavailable"));
      return manager.interrupt(threadId, turnId, commandId);
    },
    async answer(items, commandId) {
      return (await loadInteractions()).batch(items, commandId, {
        kind: "human",
        id: "local-owner",
      });
    },
  };
  const loadInteractions = () => {
    if (closed) return Promise.reject(new Error("daemon_closed"));
    loadingInteractions ??= import("./interaction-engine.js")
      .then(({ InteractionEngine }) => {
        if (closed) throw new Error("daemon_closed");
        const base = options.interactionHost ?? manager?.interactionHost;
        const host = base && {
          ...base,
          // D119 approvals are answered by the host, never by a native session.
          respond: (request: Interaction, answer: InteractionAnswer) =>
            request.nativeRef === HOST_WORKSPACE_REF
              ? respondHostApproval(runtimeContext, request, answer)
              : base.respond(request, answer),
        };
        interactions = new InteractionEngine({
          prepareInput: (input) => privacy.prepareInput(input),
          preparePublicAnswer: (request, answer) => privacy.prepareAnswer(request, answer),
          rememberPrivateValue: (value) => privacy.remember(value),
          ...(options.routineClock ? { now: options.routineClock } : {}),
          store,
          publish,
          ...(host ? { host } : {}),
          onError: (code) => logger.write("warn", code),
          onQueued: (threadId) => {
            void manager
              ?.ensure(threadId)
              .then((worker) => worker.wake())
              .catch(() => logger.write("warn", "runtime_open_failed"));
          },
        });
        if (host?.stopTurn) interactions.startTimers();
        return interactions;
      })
      .catch((error) => {
        loadingInteractions = undefined;
        throw error;
      });
    return loadingInteractions;
  };
  resources.push(async () => {
    closed = true;
    await loadingInteractions?.catch(() => {});
    await interactions?.stopTimers();
  });
  if (options.interactionHost) await loadInteractions();
  if (
    (options.interactionHost && (options.runtimeHost || options.runtime)) ||
    (options.runtimeHost && options.runtime)
  )
    throw new Error("conflicting_runtime_hosts");
  const ownedRuntime = options.runtime?.(runtimeContext);
  if (ownedRuntime) resources.push(() => ownedRuntime.close());
  const runtimeHost = ownedRuntime ?? options.runtimeHost;
  const inProcess = runtimeHost
    ? createInProcessRuntime({
        privacy,
        store,
        host: runtimeHost,
        ...(options.secrets ? { secrets: options.secrets } : {}),
        interactions: loadInteractions,
        publish,
        stream: publishRuntimeStream(publish),
        onError: (code, diagnostic) => logger.write("warn", code, diagnostic ?? {}),
      })
    : undefined;
  manager = inProcess?.manager;
  runner = inProcess?.runner;
  if (inProcess) {
    resources.push(() => inProcess.runner.close());
    await loadInteractions();
  }
  const ownedTasks = taskRunner({
    store,
    ...(options.routineClock ? { now: options.routineClock } : {}),
    ...(options.routinePollMs ? { routinePollMs: options.routinePollMs } : {}),
    ...(options.eventRoutineTransport
      ? { eventRoutineTransport: options.eventRoutineTransport }
      : {}),
    worktrees: worktreeService(options.dataDir, store),
    requestApproval: async (draft, commandId) =>
      (await loadInteractions()).request(draft, commandId),
    publish,
    checkPublic: (value) => privacy.prepareData(value),
    ...(manager
      ? {
          runner: runner as Runner,
          startInSession: true,
        }
      : {}),
    onError: (code) => logger.write("warn", code),
  });
  tasks = ownedTasks;
  resources.push(() => ownedTasks.close());
  if (manager) void ownedTasks.resume(bootId);
  else void ownedTasks.schedule();
  const runtime = runtimeApi({
    store,
    ...(manager ? { manager } : {}),
    publish,
    onError: (code) => logger.write("warn", code),
  });
  const wakes = wakeService({
    store,
    publish,
    wake: runtimeContext.wake,
    checkPublic: (value) => privacy.prepareData(value),
    ...(options.routineClock ? { now: options.routineClock } : {}),
    ...(options.eventRoutineTransport ? { transport: options.eventRoutineTransport } : {}),
    onError: (code) => logger.write("warn", code),
  });
  resources.push(() => wakes.close());
  const shipping = shippingService({
    store,
    publish,
    worktrees: worktreeService(options.dataDir, store),
    ...(options.githubClient ? { client: options.githubClient } : {}),
    ...(options.githubPublishing ? { publishing: options.githubPublishing } : {}),
    checkPublic: (value) => privacy.prepareData(value),
    wake: () => ownedTasks.schedule(),
    requestApproval: async (draft, id) => (await loadInteractions()).request(draft, id),
  });
  resources.push(() => shipping.close());
  const rules = ruleApi({ store, publish, checkPublic: (value) => privacy.prepareData(value) });
  const usage = usageApi({ store, publish });
  const knowledge = knowledgeApi({
    store,
    wake: runtimeContext.wake,
    publish,
    checkPublic: (value) => privacy.prepareData(value),
  });
  resources.push(knowledgeHygieneTimer(store, publish));
  const interaction = interactionApi({
    load: loadInteractions,
    snapshot: () => store.snapshot(),
    seq: () => store.lastSeq(),
  });
  const setupService =
    typeof options.setup === "function"
      ? options.setup({
          snapshot: () => store.snapshot(),
          async applyImport(input) {
            const { importOutcome } = await import("@zoltbot/core/imports");
            const receipt = parse(ImportReceiptSchema, input);
            const commandId = `import:${receipt.id}`;
            const check = store.receipt(commandId) ? () => {} : await privacy.prepareData(receipt);
            const before = store.lastSeq();
            const output = store.dispatch(commandId, (state) => {
              check(state);
              return importOutcome(
                state,
                receipt,
                {
                  commandId,
                  at: new Date().toISOString(),
                  actor: { kind: "human", id: "local-owner" },
                },
                true,
              );
            });
            const selected = receipt.items.map((item) => item.id).sort();
            if (JSON.stringify(output.result.selected) !== JSON.stringify(selected))
              throw new Error("import_selection_conflict");
            publish(store.eventsSince(before));
          },
        })
      : options.setup;
  const forks = forkApi({ store, ...(manager ? { manager } : {}), privacy, publish });
  const compare = compareApi({
    store,
    privacy,
    publish,
    wake: runtimeContext.wake,
    definitions: setupService ? () => setupService.definitions() : undefined,
  });
  const company = companyApi(runtimeContext);
  const companyWatch = await startCompanySupervisor(runtimeContext, {
    onError: (code) => logger.write("warn", code),
  });
  resources.push(() => companyWatch.close());

  const creation = creationApi({
    store,
    privacy,
    publish,
    ...(setupService ? { definitions: () => setupService.definitions() } : {}),
  });
  const projectFiles = projectFilesApi({ store, privacy, publish });
  const entityEdits = entityEditsApi({ store, privacy, publish });
  const settings = settingsApi({ store, privacy, redactor, publish });
  const setup = setupService
    ? setupApi(setupService, {
        checkPublic: async (value) => {
          await privacy.prepareData(value);
        },
      })
    : undefined;
  const chats = conversationServices({
    context: runtimeContext,
    quickOptions: options.quickChat,
    ...(setupService ? { definitions: () => setupService.definitions() } : {}),
    tasks: ownedTasks,
    runtime,
    createThread: (value, id) => creation("thread.create", { value }, id),
    onError: (code) => logger.write("warn", code),
  });
  orchestration = chats.orchestration;
  resources.push(() => chats.close());
  const connections = connectionsApi({
    store,
    publish,
    onChanged: () => {
      void tasks?.schedule();
    },
    ...(options.secrets ? { vault: options.secrets } : {}),
    remember: (value) => {
      privacy.remember(value);
      redactor.register(value);
    },
    checkPublic: (value) => privacy.prepareData(value),
    stopSession: async (sessionId) => {
      if (!manager) throw new Error("runtime_unavailable");
      await manager.stopSession(sessionId);
    },
  });
  resources.push(() => connections.close());
  const skills = skillsApi({
    store,
    checkPublic: (value) => privacy.prepareData(value),
    publish,
    onChanged: () => {
      void tasks?.schedule();
    },
  });
  const browser = browserApi(store, options.dataDir, {
    onReady: () => {
      void tasks?.schedule();
    },
    checkPublic: (value) => privacy.prepareData(value),
    publish,
  });
  const artifactSync = artifactRepositorySync(store, {
    publish,
    privateCheck: async (text) => {
      try {
        await privacy.prepareData(text);
        return false;
      } catch {
        return true;
      }
    },
  });
  resources.push(() => artifactSync.close());
  const artifacts = artifactsApi(runtimeContext);
  views = createViewRegistry(runtimeContext, options.dataDir, { runtime, interaction });
  await views.start(resources, () => logger.write("warn", "view_watch_failed"));
  const native = nativeApi({ snapshot: () => store.snapshot(), seq: () => store.lastSeq() });
  const dispatch = (command: Command, commandId: string) => {
    const before = store.lastSeq();
    const receipt = store.dispatch(commandId, (state) => {
      const outcome = handle(state, command, {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human", id: "local-owner" },
      });
      return redactor.value(outcome);
    });
    publish(store.eventsSince(before));
    return receipt.result;
  };
  const identity = macIdentity({ store, vault: options.secrets, publish });
  let link: RelayLink | undefined;
  const devices = deviceBook({
    store,
    publish,
    identity,
    link: () => link,
    ...(options.relay?.defaultUrl
      ? { relayDefault: options.relay.defaultUrl, wake: () => wakeRelay() }
      : {}),
  });
  const push = pushNotifier({
    store,
    devices,
    link: () => link,
    ...(options.relay?.pushDelayMs !== undefined ? { delayMs: options.relay.pushDelayMs } : {}),
  });
  resources.push(() => push.close());
  const terminals = new TerminalRuntime(() => store.snapshot());
  resources.push(() => terminals.close());
  // Zolt wakes itself only while the person is away; anything they do counts as being here.
  const chiefWake = chiefWaker({
    store,
    publish,
    wake: runtimeContext.wake,
    onError: (code) => logger.write("warn", code),
  });
  resources.push(() => chiefWake.close());
  const call = async (
    request: ReturnType<typeof parseRequest>,
    client: LinkClient,
  ): Promise<unknown> => {
    if (methodCatalog[request.method].where === "cloud") throw new Error("method_unavailable");
    if (
      request.method === "task.create" &&
      (request.params as { location?: string }).location === "sandbox"
    )
      throw new Error("cloud_task_requires_cell");
    const params = request.params as Record<string, unknown>;
    let commandId = request.commandId;
    if (commandId) chiefWake.active();
    if (client.deviceId) {
      if (macOnlyMethods.includes(request.method))
        throw new Error(`mac_only: ${request.method} works only on the Mac`);
      // Phones act as the person; the command id keeps which phone sent it (D124).
      if (commandId) {
        commandId = `device:${client.deviceId}:${commandId}`;
        if (commandId.length > 200) throw new Error("invalid_command_id");
      }
    }
    if (request.method.startsWith("terminal."))
      return terminals.api(
        request.method,
        params,
        commandId,
        client.deviceId ? `device:${client.deviceId}` : "local-owner",
        client,
      );
    switch (request.method) {
      case "hello":
        return { protocolVersion, version: "0.1.0" };
      case "snapshot.get": {
        const entities = store.snapshot();
        const partial = new Map(manager?.streamItems().map((item) => [item.id, item]) ?? []);
        if (partial.size)
          entities.item = (entities.item ?? []).map((item) => partial.get(item.id) ?? item);
        return {
          seq: store.lastSeq(),
          entities,
          counters: {
            pendingInteractions: (entities.interaction ?? []).filter((i) => i.state === "pending")
              .length,
          },
        };
      }
      case "events.subscribe": {
        const seq = store.lastSeq(),
          from = params.fromSeq;
        const replayLimit = options.replayLimit ?? 1000;
        const resync = typeof from !== "number" || from > seq || seq - from > replayLimit;
        client.subscribed = true;
        return {
          seq,
          resync,
          events: resync ? [] : store.eventsSince(from as number, replayLimit),
        };
      }
      case "events.unsubscribe":
        client.subscribed = false;
        return { ok: true };
      case "workspace.files":
        return listThreadFiles(
          store.snapshot(),
          String(params.threadId),
          String(params.query),
          typeof params.limit === "number" ? params.limit : 20,
        );
      case "diagnostics.export":
        return {
          versions: { daemon: "0.1.0", node: process.version },
          checks: [],
          logs: logger.lines,
        };
      case "provider.loginInfo": {
        if (!ownedRuntime?.loginInfo) throw new Error("provider_login_unavailable");
        const result = await ownedRuntime.loginInfo(String(params.profileId));
        await privacy.prepareData(result);
        return result;
      }
      default: {
        const result =
          (await views?.api(request.method, params, commandId)) ??
          (await company(request.method, params, commandId)) ??
          (await wakes.api(request.method, params, commandId)) ??
          (await settings(request.method, params, commandId)) ??
          (await forks(request.method, params, commandId)) ??
          (await chats.quick.api(request.method, params, commandId)) ??
          (await shipping.api(request.method, params, commandId)) ??
          (await artifacts(request.method, params, commandId)) ??
          (await browser(request.method, params)) ??
          (await connections.api(request.method, params, commandId)) ??
          (await knowledge(request.method, params, commandId)) ??
          (await skills(request.method, params, commandId)) ??
          (await devices.api(request.method, params, commandId)) ??
          (await tasks?.api(request.method, params, commandId)) ??
          (await compare(request.method, params, commandId)) ??
          (await creation(request.method, params, commandId)) ??
          (await projectFiles(request.method, params, commandId)) ??
          (await entityEdits(request.method, params, commandId)) ??
          (await inbox.api(request.method, params, commandId)) ??
          (await messages(request.method, params, commandId)) ??
          (await orchestration?.api(request.method, params, commandId)) ??
          (await runtime?.(request.method, params, commandId)) ??
          native(request.method, params) ??
          (await rules(request.method, params, commandId)) ??
          usage(request.method, params, commandId) ??
          (await interaction(request.method, params, commandId)) ??
          (await setup?.(request.method, params));
        if (result === undefined) throw new Error(`method_unavailable: ${request.method}`);
        return result;
      }
    }
  };
  const respond = async (text: string, client: LinkClient): Promise<string> => {
    let id: string | number | null = null;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("malformed_json");
      }
      if (
        raw &&
        typeof raw === "object" &&
        "id" in raw &&
        (typeof raw.id === "string" || typeof raw.id === "number")
      )
        id = raw.id;
      const request = parseRequest(raw, localCommandActor(client.deviceId));
      const result = await call(request, client);
      logger.write("info", "API request", {
        method: request.method,
        ...(client.deviceId ? { from: "phone" } : {}),
      });
      return JSON.stringify({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const message = redactor.text(error instanceof Error ? error.message : "internal");
      logger.write("warn", "Rejected API request", { message });
      return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } });
    }
  };
  server.on("connection", (socket) => {
    let authenticated = false;
    const client: LinkClient = {
      subscribed: false,
      send(text) {
        if (socket.readyState === WebSocket.OPEN) socket.send(text);
      },
    };
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(4401, "unauthorized");
    }, 5000);
    authTimer.unref();
    socket.on("close", () => {
      clearTimeout(authTimer);
      terminals.detach(client);
      clients.delete(client);
    });
    socket.on("error", (error) =>
      logger.write("warn", "Client connection error", { message: error.message }),
    );
    socket.on("message", async (data) => {
      const text = data.toString();
      if (!authenticated) {
        let raw: { id?: unknown; method?: unknown; params?: { token?: unknown } } | undefined;
        try {
          raw = JSON.parse(text);
        } catch {}
        if (raw?.method !== "hello" || !equalToken(String(raw.params?.token), token)) {
          const id = typeof raw?.id === "string" || typeof raw?.id === "number" ? raw.id : null;
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32001, message: "unauthorized" },
            }),
          );
          socket.close(4401, "unauthorized");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        clients.add(client);
      }
      client.send(await respond(text, client));
    });
  });
  link = relayLink({
    identity,
    answer: (hello, from) => devices.answer(hello, from),
    allowed: (deviceId) => devices.allowed(deviceId),
    serve: (text, client) => respond(text, client),
    attach: (client) => clients.add(client),
    detach: (client) => {
      terminals.detach(client);
      clients.delete(client);
    },
    ready: () => devices.ready(),
    presence: (deviceId, online, lastSeenAt) =>
      devices.seen(deviceId, online ? undefined : (lastSeenAt ?? new Date().toISOString())),
    log: (level, message, detail) => logger.write(level, message, detail),
    ...(options.relay?.retry ? { retry: options.relay.retry } : {}),
    ...(options.relay?.pingMs ? { pingMs: options.relay.pingMs } : {}),
  });
  const ownedLink = link;
  resources.push(() => ownedLink.close());
  const relaySetting = () => {
    const value = store
      .snapshot(["settings"])
      .settings?.find((row) => row.key === "link.relayUrl")?.value;
    return typeof value === "string" ? value : undefined;
  };
  // A chosen address stays connected. The build's default relay serves only Macs that have
  // a phone paired, waiting, or about to scan a code, so idle installs hold no socket.
  const syncRelay = () => {
    if (!options.secrets) return;
    const chosen = relaySetting()?.trim();
    const fallback = devices.wanted() ? options.relay?.defaultUrl : undefined;
    ownedLink.configure(chosen || fallback);
  };
  const wakeRelay = async () => {
    syncRelay();
    // Let the link close again if the code expires unscanned.
    setTimeout(syncRelay, pairingOfferTtlMs + 1000).unref();
    await ownedLink.online(10_000);
  };
  const taint = taintObserver(store);
  observers = (events) => {
    companyWatch.observe();
    push.observe(events);
    taint(events);
    for (const event of events)
      if (
        event.aggregateType === "task" &&
        ["completed", "cancelled"].includes(String((event.payload as { state?: string }).state))
      ) {
        try {
          frozenBrowser(store, event.aggregateId);
          void browser(
            "browser.action",
            {
              id: event.aggregateId,
              action: "stop",
              confirmed: true,
            },
            "task_policy",
          ).catch(() => logger.write("warn", "Owned browser cleanup needs attention"));
        } catch {}
      }
    // Without the Keychain there is no Mac identity, so the link stays off.
    if (
      events.some(
        (event) => event.aggregateId === "link.relayUrl" || event.aggregateType === "device",
      )
    )
      syncRelay();
  };
  syncRelay();
  writeConnectionFile(
    connectionFile,
    JSON.stringify({ url, token, pid: process.pid, protocolVersion }),
  );
  chmodSync(connectionFile, 0o600);
  logger.write("info", "Daemon ready", { recovered: true });
  return {
    url,
    token,
    dataDir: options.dataDir,
    store,
    logger,
    get interactions() {
      return interactions;
    },
    dispatch,
    async close() {
      if (closing) return closing;
      closed = true;
      closing = dispose();
      return closing;
    },
  };
}
