import {
  type ArtifactTarget,
  compareSessions,
  type NativeCommand,
  NativeCommandSchema,
  parse,
  terms,
} from "@zoltbot/protocol";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { artifactRevisionAvailable } from "../artifacts/OutputControl.js";
import { CompareCeiling } from "../compare/CompareCeiling.js";
import { ThreadLetters } from "../inbox/ThreadLetters.js";
import { setThreadView, useThreadView } from "../inbox/view-mode.js";
import { ChatRoutineCards } from "../tasks/EventRoutine.js";
import { BackgroundTasks } from "./BackgroundTasks.js";
import { CompactControl } from "./CompactControl.js";
import { CompletionCard } from "./CompletionCard.js";
import { Composer } from "./Composer.js";
import { EditDialog } from "./EditDialog.js";
import { ForkControl, ForkHistory } from "./ForkControl.js";
import { ModePicker, useModeControl } from "./ModePicker.js";
import { permissionLabel, sessionModes, sessionSafeModes } from "./mode-data.js";
import { OrchestrationRuns } from "./OrchestrationRuns.js";
import { Overhead } from "./Overhead.js";
import { PinnedTodo } from "./PinnedTodo.js";
import { ProviderAccess } from "./ProviderAccess.js";
import { backgroundTasks } from "./parity-data.js";
import { QueueStrip } from "./QueueStrip.js";
import { ResultsPanel } from "./ResultsPanel.js";
import { RewindDialog } from "./RewindDialog.js";
import { SessionBanner } from "./SessionBanner.js";
import { messageSources } from "./sources.js";
import { Timeline } from "./Timeline.js";
import { groupTimeline, stableNested } from "./timeline-data.js";
import { body, type ChatConnection, type Row, text } from "./types.js";
import "./chat.css";
import "./context.css";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  IconButton,
  PropertyList,
  SectionLabel,
} from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import { useShell } from "../state.js";
import { scopeLabel } from "../workspaces/activity.js";
import { emptyRows } from "../workspaces/view.js";

const TerminalPanel = lazy(() => import("./TerminalPanel.js"));
const PendingInteraction = lazy(() => import("../interactions/PendingInteraction.js"));
export default function Chat({
  connection,
  threadId,
}: {
  connection: ChatConnection;
  threadId: string;
}) {
  const entities = connection.snapshot.entities;
  const [showContext, setShowContext] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const view = useThreadView();
  const terminalToggle = useRef<HTMLButtonElement>(null);
  const [targetSelection, setTargetSelection] = useState<{
    threadId: string;
    target: ArtifactTarget;
  }>();
  const artifactTarget =
    targetSelection?.threadId === threadId ? targetSelection.target : undefined;
  const setArtifactTarget = (target: ArtifactTarget | undefined) =>
    setTargetSelection(target ? { threadId, target } : undefined);
  const onRevise = artifactRevisionAvailable(connection, threadId) ? setArtifactTarget : undefined;
  const toggleSidebar = useShell((s) => s.toggleSidebar),
    sidebar = useShell((s) => s.sidebar);
  const thread = entities.thread?.find((row) => row.id === threadId),
    profile = entities.agent?.find((row) => row.id === thread?.agentId),
    definition = entities.agentDefinition?.find((row) => row.id === profile?.definitionId);
  const project = entities.project?.find((row) => row.id === thread?.projectId);
  const session = entities.session
    ?.filter((row) => row.threadId === threadId)
    .sort(compareSessions)[0];
  const caps =
    session?.capabilities && typeof session.capabilities === "object"
      ? (session.capabilities as Record<string, unknown>)
      : {};
  const commands = useMemo(() => {
    if (!Array.isArray(caps.slashCommands)) return undefined;
    const result: NativeCommand[] = [];
    for (const value of caps.slashCommands) {
      try {
        result.push(parse(NativeCommandSchema, value));
      } catch {}
    }
    return result.slice(0, 100);
  }, [caps.slashCommands]);
  const compaction =
    caps.compaction && typeof caps.compaction === "object"
      ? (caps.compaction as Record<string, unknown>)
      : {};
  const activeTurn = entities.turn?.find(
    (row) => row.threadId === threadId && row.status === "running",
  );
  const latestTurn =
    activeTurn ??
    entities.turn
      ?.filter((row) => row.sessionId === session?.id)
      .sort(
        (a, b) =>
          text(b.startedAt).localeCompare(text(a.startedAt)) ||
          text(b.id).localeCompare(text(a.id)),
      )[0];
  const busy = !!activeTurn;
  const threadTurns = useMemo(
    () => (entities.turn ?? []).filter((row) => row.threadId === threadId),
    [entities.turn, threadId],
  );
  const compareReadOnly =
    entities.compareMember?.some((r) => r.threadId === threadId && r.ceiling === "read_only") ||
    entities.compare?.some((r) => r.summaryThreadId === threadId);
  const hasPending =
    entities.interaction?.some((row) => row.threadId === threadId && row.state === "pending") ??
    false;
  const previousPending = useRef(false);
  const focusedThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!thread) return;
    if (!hasPending && (previousPending.current || focusedThread.current !== threadId))
      document.querySelector<HTMLTextAreaElement>(".chat-composer textarea")?.focus();
    focusedThread.current = threadId;
    previousPending.current = hasPending;
  }, [hasPending, thread, threadId]);
  const items = useMemo(
    () =>
      (entities.item ?? [])
        .filter((row) => row.threadId === threadId)
        .sort((a, b) => Number(a.seq) - Number(b.seq)),
    [entities.item, threadId],
  );
  // Approvals with a place in the conversation are answered there, where the tool would run.
  const inlineRequests = useMemo(
    () =>
      new Set(
        items.flatMap((item) =>
          item.kind === "interaction" && text(body(item).interactionId)
            ? [text(body(item).interactionId)]
            : [],
        ),
      ),
    [items],
  );
  const pendingBelow =
    entities.interaction?.some(
      (row) =>
        row.threadId === threadId &&
        row.state === "pending" &&
        !(row.type === "approval" && inlineRequests.has(text(row.id))),
    ) ?? false;
  const usage = useMemo(
    () =>
      (entities.usage ?? []).filter((row) =>
        entities.session?.some(
          (session) => session.id === row.sessionId && session.threadId === threadId,
        ),
      ),
    [entities.usage, entities.session, threadId],
  );
  const queued = items.filter(
    (row) =>
      row.kind === "user" &&
      ["queued", "sending", "uncertain"].includes(text(body(row).queueState)),
  );
  const groups = useMemo(() => groupTimeline(items), [items]);
  const nestedCache = useRef<Map<string, Row[]> | undefined>(undefined);
  const nested = useMemo(() => {
    nestedCache.current = stableNested(nestedCache.current, groups.nested);
    return nestedCache.current;
  }, [groups.nested]);
  const modes = useMemo(() => sessionModes(caps), [caps]);
  const sources = useMemo(
    () => messageSources(entities.audit ?? [], entities.thread ?? [], entities.agent ?? []),
    [entities.audit, entities.thread, entities.agent],
  );
  const safeModes = useMemo(() => sessionSafeModes(caps), [caps]);
  const modeControl = useModeControl(
    connection,
    typeof session?.id === "string" && session.state !== "ended" ? session.id : undefined,
    modes,
    text(session?.mode) || (modes.includes("default") ? "default" : ""),
    safeModes,
  );
  const background = useMemo(() => backgroundTasks(session), [session]);
  const [rewinding, setRewinding] = useState<string>();
  const canRewind = caps.rewind === true && typeof session?.id === "string";
  const onRewind = useCallback((item: Row) => setRewinding(text(item.turnId)), []);
  const [editing, setEditing] = useState<Row>();
  const onEdit = useCallback((item: Row) => setEditing(item), []);
  const [error, setError] = useState(""),
    [stopping, setStopping] = useState(false);
  const stopAttempt = useRef<{ turnId: string; id: string } | undefined>(undefined);
  const stopRequested =
    !!activeTurn &&
    items.some((row) => body(row).code === "turn_interrupt" && body(row).turnId === activeTurn.id);
  const interrupt = async () => {
    if (!activeTurn || stopRequested) return;
    const turnId = text(activeTurn.id);
    if (stopAttempt.current?.turnId !== turnId)
      stopAttempt.current = { turnId, id: crypto.randomUUID() };
    setStopping(true);
    setError("");
    try {
      await connection.call("turn.interrupt", { threadId, turnId }, stopAttempt.current.id);
    } finally {
      setStopping(false);
    }
  };
  useEffect(() => {
    window.zoltDesktop?.visibleThread?.(threadId);
    return () => window.zoltDesktop?.visibleThread?.();
  }, [threadId]);
  if (!thread)
    return (
      <section className="zb-card empty-page">
        <EmptyState level={1} icon="Sessions" title="Conversation unavailable">
          Choose another saved conversation.
        </EmptyState>
      </section>
    );
  const name = text(profile?.name) || "Your profile",
    tool = text(definition?.displayName) || "Coding tool";
  // Where the chat lives, as on Overview's recent chats; the coding tool sits with the profile.
  const place =
    scopeLabel(thread, entities.project ?? emptyRows, entities.subproject ?? emptyRows) ||
    `Not in a ${terms.workspace.one}`;
  const permissions = permissionLabel(text(profile?.permissionProfile));
  const letters = view === "letters" && !compareReadOnly;
  return (
    <section className="chat-workspace" aria-label="Chat workspace">
      <header className="chat-header">
        <IconButton
          icon="Menu"
          size="sm"
          label={sidebar ? "Hide sidebar" : "Show sidebar"}
          onClick={toggleSidebar}
        />
        <div className="chat-title">
          <span className="chat-place truncate" title={place}>
            <bdi>{place}</bdi>
          </span>
          <Icon name="ChevronRight" size="sm" />
          <h1>{text(thread.title) || "Conversation"}</h1>
        </div>
        {busy ? (
          <Chip tone="accent" dot>
            Working
          </Chip>
        ) : session?.state === "ready" ? (
          <Chip>Ready</Chip>
        ) : null}
        <span className="sp" />
        {!compareReadOnly && session?.cwd && profile?.permissionProfile !== "read_only" ? (
          <IconButton
            ref={terminalToggle}
            icon="Terminal"
            label={showTerminal ? "Hide terminal" : "Show terminal"}
            aria-expanded={showTerminal}
            size="sm"
            onClick={() => setShowTerminal((value) => !value)}
          />
        ) : null}
        <ForkControl
          connection={connection}
          threadId={threadId}
          title={text(thread.title) || "Conversation"}
        />
        {activeTurn && ["native", "kill"].includes(text(caps.interrupt)) ? (
          <Button
            size="sm"
            disabled={stopping || stopRequested || connection.status !== "online"}
            title={
              caps.interrupt === "kill"
                ? "Stop the native session process"
                : "Ask the coding tool to stop this turn"
            }
            onClick={() => {
              void interrupt().catch(() =>
                setError(
                  "Stopping could not be confirmed. Review the native session before continuing.",
                ),
              );
            }}
          >
            {stopping || stopRequested ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
        {compareReadOnly ? null : (
          <Button
            size="sm"
            aria-pressed={letters}
            title="Read this chat as letters, like the Inbox"
            onClick={() => setThreadView(letters ? "chat" : "letters")}
          >
            Letters
          </Button>
        )}
        <Button
          size="sm"
          aria-expanded={showResults}
          onClick={() => {
            setShowResults(!showResults);
            setShowContext(false);
          }}
        >
          Results
        </Button>
        <IconButton
          icon="Info"
          size="sm"
          label={showContext ? "Hide conversation details" : "Show conversation details"}
          aria-expanded={showContext}
          onClick={() => {
            setShowContext((value) => !value);
            setShowResults(false);
          }}
        />
        <div className="chat-profile" title={`${name} · ${tool}`}>
          <Avatar
            name={name}
            id={text(profile?.id) || name}
            size={20}
            tool={text(definition?.id)}
          />
          <span>{name}</span>
        </div>
        <Chip>{permissions || "Permissions not reported"}</Chip>
      </header>
      {error ? (
        <p className="chat-error" role="alert">
          {error}
        </p>
      ) : null}
      {showTerminal && !compareReadOnly ? (
        <Suspense fallback={null}>
          <TerminalPanel
            key={threadId}
            connection={connection}
            threadId={threadId}
            onClose={() => {
              setShowTerminal(false);
              terminalToggle.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
      <div className="chat-main">
        <div className="chat-conversation">
          {thread.fork ? (
            <ForkHistory
              connection={connection}
              threadId={threadId}
              provenance={thread.fork as Row}
            />
          ) : null}
          <OrchestrationRuns connection={connection} threadId={threadId} />
          {letters ? (
            <ThreadLetters
              key={threadId}
              connection={connection}
              threadId={threadId}
              name={name}
              busy={busy}
              steer={caps.steer === "native"}
              onResults={() => {
                setShowResults(true);
                setShowContext(false);
              }}
            />
          ) : (
            <Timeline
              connection={connection}
              onRevise={onRevise}
              items={groups.top}
              nested={nested}
              name={name}
              usage={usage}
              interactions={entities.interaction ?? []}
              turns={threadTurns}
              sources={sources}
              onRewind={canRewind ? onRewind : undefined}
              onEdit={compareReadOnly ? undefined : onEdit}
            />
          )}
          <ChatRoutineCards connection={connection} threadId={threadId} />
          {editing ? (
            <EditDialog
              connection={connection}
              threadId={threadId}
              title={text(thread.title) || "Chat"}
              item={editing}
              sessionId={canRewind ? text(session?.id) : undefined}
              onClose={() => setEditing(undefined)}
            />
          ) : null}
          {rewinding && typeof session?.id === "string" ? (
            <RewindDialog
              connection={connection}
              sessionId={session.id}
              turnId={rewinding}
              onClose={() => setRewinding(undefined)}
            />
          ) : null}
          {background.length && typeof session?.id === "string" ? (
            <BackgroundTasks
              connection={connection}
              sessionId={session.id}
              tasks={background}
              canStop={caps.backgroundTasks === true}
            />
          ) : null}
          {groups.latestPlan ? <PinnedTodo plan={groups.latestPlan} /> : null}
          {queued.length && !letters ? (
            <QueueStrip connection={connection} threadId={threadId} items={queued} />
          ) : null}
          <SessionBanner
            connection={connection}
            threadId={threadId}
            session={session}
            items={items}
          />
          {pendingBelow && !letters ? (
            <Suspense fallback={<p className="sm">Loading pending request…</p>}>
              <PendingInteraction
                connection={connection}
                threadId={threadId}
                profile={name}
                inline={inlineRequests}
              />
            </Suspense>
          ) : null}
          <CompareCeiling connection={connection} threadId={threadId} />
          {!letters ? (
            <CompletionCard
              connection={connection}
              threadId={threadId}
              onResults={() => {
                setShowResults(true);
                setShowContext(false);
              }}
            />
          ) : null}
          {letters ? null : (
            <Composer
              artifactTarget={artifactTarget}
              clearArtifactTarget={() => setArtifactTarget(undefined)}
              connection={connection}
              threadId={threadId}
              name={name}
              {...(project?.name ? { projectName: text(project.name) } : {})}
              busy={busy}
              steer={caps.steer === "native"}
              images={caps.images === true}
              {...(commands ? { commands } : {})}
              {...(!compareReadOnly && modes.length && modeControl.current
                ? {
                    modeControl: <ModePicker control={modeControl} />,
                    onCycleMode: modeControl.cycle,
                  }
                : {})}
              {...(busy &&
              !stopping &&
              !stopRequested &&
              ["native", "kill"].includes(text(caps.interrupt))
                ? { interrupt }
                : {})}
            />
          )}
        </div>
        {showResults ? (
          <ResultsPanel
            key={threadId}
            connection={connection}
            threadId={threadId}
            onClose={() => setShowResults(false)}
            onRevise={onRevise}
          />
        ) : null}
        {showContext ? (
          <section className="chat-context" aria-label="Conversation context">
            <h2 className="chat-context-title">Context</h2>
            <section className="chat-context-section" aria-label="Native session">
              <SectionLabel>Native session</SectionLabel>
              <PropertyList
                items={[
                  { label: "State", value: text(session?.state) || "Not connected yet" },
                  {
                    label: "Working folder",
                    value: session?.cwd ? <code>{text(session.cwd)}</code> : "Private app folder",
                  },
                ]}
              />
              <details className="chat-context-hint">
                <summary>About this session</summary>
                <p>
                  History stays in your coding tool. Profile and instruction changes apply to new
                  conversations.
                </p>
              </details>
            </section>
            {profile && definition ? (
              <ProviderAccess
                key={text(profile.id)}
                connection={connection}
                profileId={text(profile.id)}
                provider={text(definition.id)}
              />
            ) : null}
            {project ? (
              <section
                className="chat-context-section"
                aria-label={`Conversation ${terms.workspace.one}`}
              >
                <SectionLabel>{terms.workspace.One}</SectionLabel>
                <p>
                  <bdi>{text(project.name)}</bdi>
                </p>
              </section>
            ) : null}
            <Overhead
              rows={usage}
              sessionId={typeof session?.id === "string" ? session.id : undefined}
              turnId={typeof latestTurn?.id === "string" ? latestTurn.id : undefined}
            />
            <CompactControl
              connection={connection}
              sessionId={typeof session?.id === "string" ? session.id : undefined}
              available={compaction.manual === true}
              ready={session?.state === "ready" && !busy}
              onError={setError}
            />
          </section>
        ) : null}
      </div>
    </section>
  );
}
