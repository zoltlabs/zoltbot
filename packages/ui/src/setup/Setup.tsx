import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type ImportItem,
  type PermissionProfile,
  ProfileSchema,
  parse,
  ThreadSchema,
} from "@zoltbot/protocol";
import { lazy, type ReactNode, Suspense, useMemo, useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Chip, Spinner } from "../components/primitives.js";
import { Devices } from "../settings/Devices.js";
import { doctorChecks } from "./doctor-data.js";
import { importPreview } from "./import-data.js";
import {
  type AgentRow,
  agentRows,
  defaultAgents,
  firstChatAgent,
  historySources,
  importSelection,
  type Range,
  type SessionGroup,
  serverRows,
  sessionGroups,
  sourceName,
} from "./onboarding-data.js";
import { AccountLink, AgentRows, plural, RepositoryRows } from "./onboarding-parts.js";
import { completeOnboarding } from "./onboarding-state.js";
import { starterDraft } from "./starter.js";
import "./setup.css";

const ImportReview = lazy(() => import("./ImportReview.js"));

const steps = ["welcome", "agents", "sessions", "tools", "defaults", "ready"] as const;
type Step = (typeof steps)[number];
const numbered = steps.length - 2;
const approvals: [PermissionProfile, string, string][] = [
  [
    "workspace_write",
    "Edit freely inside the project",
    "Agents edit files and run safe commands in the project. Anything outside it asks first.",
  ],
  ["full_access", "Full access", "No approvals. Best for sandboxes and throwaway repositories."],
  ["read_only", "Read only", "Agents read and suggest. Some coding tools do not offer this mode."],
];
export default function Setup({
  connection,
  onOpen,
  onSkip,
  onDoctor,
}: {
  connection: ChatConnection;
  onOpen(id: string): void;
  onSkip(): void;
  onDoctor(): void;
}) {
  const cache = useQueryClient();
  const entities = connection.snapshot.entities;
  const [step, setStep] = useState<Step>("welcome");
  const heading = useRef<HTMLHeadingElement>(null);
  const go = (next: Step) => {
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  };
  const [advanced, setAdvanced] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [items, setItems] = useState<{ id: string; items: ImportItem[] }>();
  const [range, setRange] = useState<Range>(90);
  const [query, setQuery] = useState("");
  const [repositories, setRepositories] = useState(new Set<string>());
  const [sessions, setSessions] = useState(new Set<string>());
  const [open, setOpen] = useState(new Set<string>());
  const [servers, setServers] = useState(new Set<string>());
  const [approval, setApproval] = useState<PermissionProfile>("workspace_write");
  const [phone, setPhone] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [agent, setAgent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [imported, setImported] = useState(0);
  const [reviewed, setReviewed] = useState<number>();
  const created = useRef(new Map<string, string>());

  // The scan starts when the user clicks Get started, never on its own.
  const scan = useMutation({
    mutationFn: async () => {
      await connection.call("detect.scan", {});
      const checks = doctorChecks(await connection.call("doctor.report", {}));
      cache.setQueryData(["doctor-report"], checks);
      return agentRows(checks);
    },
    onSuccess: (rows) => setSelected(defaultAgents(rows)),
  });
  const rows = scan.data ?? [];
  const recheck = useMutation({
    mutationFn: async () => {
      const checks = doctorChecks(await connection.call("doctor.report", {}));
      cache.setQueryData(["doctor-report"], checks);
      return agentRows(checks);
    },
    onSuccess: (next) => {
      setFresh(next);
      setSelected((previous) => new Set([...previous, ...defaultAgents(next)]));
    },
  });
  const [fresh, setFresh] = useState<AgentRow[]>();
  const agentList = fresh ?? rows;
  const signIn = useMutation({
    mutationFn: (definitionId: string) =>
      connection.call("detect.startLogin", { definitionId }, crypto.randomUUID()),
  });
  const connected = agentList.filter((row) => row.ready && selected.has(row.id));

  const read = useMutation({
    mutationFn: async () =>
      importPreview(
        await connection.call("import.preview", {
          consent: true,
          sources: historySources(connected.map((row) => row.id)),
        }),
      ),
    onSuccess: (preview) => {
      setItems(preview);
      setRepositories(
        new Set(
          sessionGroups(preview.items, 90)
            .groups.filter((group) => group.repoRoot)
            .map((group) => group.key),
        ),
      );
      setSessions(
        new Set(
          sessionGroups(preview.items, 90).groups.flatMap((group) =>
            group.sessions.map((row) => row.id),
          ),
        ),
      );
      setServers(new Set(serverRows(preview.items).map((row) => row.name)));
    },
  });
  const { groups, brief } = useMemo(() => sessionGroups(items?.items ?? [], range), [items, range]);
  const shown = groups.filter((group) =>
    group.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const inRange = groups.flatMap((group) => group.sessions.map((row) => row.id));
  const chosenSessions = new Set(inRange.filter((id) => sessions.has(id)));
  const chosenRepositories = groups.filter(
    (group) => group.repoRoot && repositories.has(group.key),
  );
  const mcp = serverRows(items?.items ?? []);
  const chosenServers = new Set(
    mcp.filter((row) => servers.has(row.name)).flatMap((row) => row.ids),
  );

  const finish = useMutation({
    mutationFn: async () => {
      if (items) {
        const ids = importSelection(
          items.items,
          chosenSessions,
          chosenServers,
          new Set(chosenRepositories.flatMap((group) => (group.repoRoot ? [group.repoRoot] : []))),
        );
        if (ids.length)
          await connection.call(
            "import.apply",
            { previewId: items.id, selected: ids, consent: true },
            `import:${items.id}`,
          );
        setImported(chosenSessions.size);
      }
      for (const row of connected) {
        if (created.current.has(row.id)) continue;
        const existing = connection.snapshot.entities.agent?.find(
          (profile) =>
            profile.definitionId === row.id &&
            profile.kind === "profile" &&
            !profile.archived &&
            !profile.hidden,
        );
        const draft = starterDraft(
          { id: row.id, displayName: row.name },
          { profile: crypto.randomUUID(), thread: crypto.randomUUID() },
          new Date().toISOString(),
          undefined,
          approval,
        );
        const profile = existing
          ? parse(ProfileSchema, existing)
          : parse(
              ProfileSchema,
              await connection.call(
                "agent.create",
                { value: draft.profile },
                `onboarding:${row.id}:${draft.profile.id}`,
              ),
            );
        created.current.set(row.id, profile.id);
      }
    },
    onSuccess: () => {
      completeOnboarding();
      setAgent(firstChatAgent(connected.map((row) => row.id)) ?? "");
      go("ready");
    },
  });

  const start = useMutation({
    mutationFn: async () => {
      const profileId = created.current.get(agent);
      if (!profileId) throw new Error("no_starter_selected");
      const project = projectId || undefined;
      const previous = prompt.trim()
        ? undefined
        : connection.snapshot.entities.thread?.find(
            (thread) =>
              thread.agentId === profileId &&
              thread.kind === "main" &&
              !thread.archived &&
              thread.projectId === project,
          );
      const draft = starterDraft(
        { id: agent, displayName: agent },
        { profile: profileId, thread: crypto.randomUUID() },
        new Date().toISOString(),
        project,
      );
      const thread = previous
        ? parse(ThreadSchema, previous)
        : parse(
            ThreadSchema,
            await connection.call(
              "thread.create",
              { value: draft.thread },
              `onboarding:thread:${draft.thread.id}`,
            ),
          );
      if (prompt.trim()) {
        await connection.call(
          "turn.send",
          {
            threadId: thread.id,
            input: [{ type: "text", text: prompt }],
            mode: "queue",
            outputMode: "auto",
          },
          crypto.randomUUID(),
        );
        await connection
          .call("session.connect", { threadId: thread.id }, crypto.randomUUID())
          .catch(() => undefined);
      }
      return thread.id;
    },
    onSuccess: onOpen,
  });

  const offline = connection.status !== "online";
  const busy = scan.isPending || read.isPending || finish.isPending || start.isPending;
  if (advanced)
    return (
      <Suspense fallback={<p>Loading import review</p>}>
        <ImportReview
          connection={connection}
          onBack={(count) => {
            setAdvanced(false);
            setItems(undefined);
            if (count !== undefined) setReviewed(count);
          }}
        />
      </Suspense>
    );

  const n = steps.indexOf(step);
  const frame = (
    title: string,
    sub: string,
    body: ReactNode,
    next: {
      label: string;
      disabled?: boolean;
      hidden?: boolean;
      reason?: string;
      onClick(): void;
    },
    skip?: () => void,
  ) => (
    <>
      <header className="onb-head">
        <div className="onb-progress">
          <span className="onb-dots" aria-hidden="true">
            {Array.from({ length: numbered }, (_, k) => (
              <i key={String(k)} className={k + 1 < n ? "done" : k + 1 === n ? "on" : ""} />
            ))}
          </span>
          <span>
            Step {n} of {numbered}
          </span>
        </div>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="onb-sub">{sub}</p>
      </header>
      {body}
      <footer className="onb-foot">
        <Button variant="ghost" disabled={busy} onClick={() => go(steps[n - 1] ?? "welcome")}>
          Back
        </Button>
        <span className="grow" />
        {skip ? (
          <Button variant="ghost" disabled={busy} onClick={skip}>
            Skip for now
          </Button>
        ) : null}
        {next.hidden ? null : (
          <Button
            variant="primary"
            disabled={busy || offline || next.disabled}
            aria-describedby={next.disabled && next.reason ? "onb-reason" : undefined}
            onClick={next.onClick}
          >
            {next.label}
          </Button>
        )}
      </footer>
      {next.disabled && next.reason ? (
        <p className="onb-reason" id="onb-reason">
          {next.reason}
        </p>
      ) : null}
    </>
  );

  let view: ReactNode;
  if (step === "welcome")
    view = (
      <div className="onb-welcome">
        <h1 ref={heading} tabIndex={-1}>
          Your coding agents, working as one team
        </h1>
        <p className="onb-sub">
          Zoltbot runs Claude Code, Codex and others side by side. It uses each tool’s own login and
          sessions, so nothing changes in the apps you already use.
        </p>
        <ul className="onb-trust">
          <li>No account needed. Everything stays on this Mac unless you save something online.</li>
          <li>Read only. Zoltbot never writes to ~/.claude or ~/.codex.</li>
          <li>No prompts are sent during setup, so it costs no tokens.</li>
        </ul>
        <div className="onb-actions">
          <Button
            variant="primary"
            size="lg"
            disabled={offline}
            onClick={() => {
              if (!scan.data && !scan.isPending) scan.mutate();
              go("agents");
            }}
          >
            Get started
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Skip, I will add agents myself
          </Button>
        </div>
        <AccountLink />
      </div>
    );
  else if (step === "agents") {
    const found = agentList.filter((row) => row.path).length;
    view = frame(
      "Connect your coding agents",
      scan.isPending
        ? "Looking for coding agents on this Mac…"
        : `Found ${plural(found, "coding agent")} on this Mac. Each one keeps its own login.`,
      <section className="card onb-card" aria-label="Detected coding agents">
        <div className="onb-card-head">
          Detected agents <span className="onb-n">{found}</span>
          <span className="grow" />
          {scan.isSuccess || fresh ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => recheck.mutate()}>
              Check again
            </Button>
          ) : null}
        </div>
        {scan.isPending ? (
          <p className="onb-scan">
            <Spinner size="sm" label="Scanning" /> Checking PATH, Homebrew, npm and app bundles
          </p>
        ) : null}
        <div className="onb-rows">
          <AgentRows
            rows={agentList}
            selected={selected}
            setSelected={setSelected}
            disabled={busy}
            signingIn={signIn.isPending}
            onSignIn={(id) => signIn.mutate(id)}
            onInstallHelp={onDoctor}
          />
        </div>
        {signIn.isSuccess ? (
          <output className="onb-hint">
            Finish signing in in the window that opened, then choose Check again.
          </output>
        ) : null}
        {!scan.isPending && !agentList.length ? (
          <p className="onb-hint">No coding agents were found. Open Doctor to review detection.</p>
        ) : null}
      </section>,
      {
        label: connected.length ? `Connect ${plural(connected.length, "agent")}` : "Next",
        disabled: scan.isPending || !connected.length,
        reason: scan.isPending
          ? "Still checking this Mac. This takes a few seconds."
          : "Choose at least one agent to continue.",
        onClick: () => go("sessions"),
      },
    );
  } else if (step === "sessions") {
    const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
    const toggle = (ids: string[], on: boolean) => {
      if (on)
        setRepositories(
          (previous) =>
            new Set([
              ...previous,
              ...groups
                .filter(
                  (group) => group.repoRoot && group.sessions.some((row) => ids.includes(row.id)),
                )
                .map((group) => group.key),
            ]),
        );
      setSessions((previous) => {
        const next = new Set(previous);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    };
    const toggleRepository = (group: SessionGroup, on: boolean) => {
      setRepositories((previous) => {
        const next = new Set(previous);
        if (on) next.add(group.key);
        else next.delete(group.key);
        return next;
      });
      toggle(
        group.sessions.map((row) => row.id),
        on,
      );
    };
    const sources = historySources(connected.map((row) => row.id)).map(sourceName);
    view = frame(
      "Select repositories and sessions",
      items
        ? `${plural(total, "session")} ${range === "all" ? "" : `from the last ${range} days `}in ${sources.join(" and ")}`
        : "List past sessions here so you can pick them up again from Zoltbot.",
      <>
        {!items ? (
          <section className="card onb-card onb-consent" aria-label="Read session history">
            <p>
              Zoltbot reads session names, dates and working folders from{" "}
              {sources.join(" and ") || "your agents"}, plus each repository’s GitHub name.
              Conversations are not opened, and nothing is copied or sent.
            </p>
            <div className="onb-actions">
              <Button
                variant="primary"
                disabled={busy || offline || !sources.length}
                onClick={() => read.mutate()}
              >
                {read.isPending ? "Reading…" : "Find my sessions"}
              </Button>
              <Button variant="ghost" onClick={() => setAdvanced(true)}>
                Choose sources and folders yourself
              </Button>
            </div>
            {reviewed !== undefined ? (
              <p className="onb-hint">{plural(reviewed, "metadata item")} saved</p>
            ) : null}
          </section>
        ) : (
          <>
            <div className="onb-toolbar">
              <fieldset className="onb-seg" aria-label="Date range">
                {(
                  [
                    ["all", "All time"],
                    [90, "Last 90 days"],
                    [30, "Last 30 days"],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    key={text}
                    type="button"
                    aria-pressed={range === value}
                    onClick={() => {
                      // A new range starts with every session in it chosen, as on first load.
                      setRange(value);
                      setRepositories(
                        new Set(
                          sessionGroups(items?.items ?? [], value)
                            .groups.filter((group) => group.repoRoot)
                            .map((group) => group.key),
                        ),
                      );
                      setSessions(
                        new Set(
                          sessionGroups(items?.items ?? [], value).groups.flatMap((group) =>
                            group.sessions.map((row) => row.id),
                          ),
                        ),
                      );
                    }}
                  >
                    {text}
                  </button>
                ))}
              </fieldset>
              <span className="grow" />
              <input
                className="onb-search"
                type="search"
                aria-label="Filter repositories"
                placeholder="Filter repositories"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="onb-toolbar">
              <Button onClick={() => setSessions(new Set())}>Import repositories only</Button>
            </div>
            <section className="card onb-card" aria-label="Repositories">
              <div className="onb-card-head">
                <input
                  type="checkbox"
                  aria-label="Select all repositories and sessions"
                  checked={
                    groups.length > 0 &&
                    chosenRepositories.length === groups.filter((group) => group.repoRoot).length &&
                    chosenSessions.size === inRange.length
                  }
                  ref={(element) => {
                    if (element)
                      element.indeterminate =
                        (chosenSessions.size > 0 || chosenRepositories.length > 0) &&
                        (chosenSessions.size < inRange.length ||
                          chosenRepositories.length <
                            groups.filter((group) => group.repoRoot).length);
                  }}
                  onChange={(event) => {
                    setRepositories(
                      new Set(
                        event.target.checked
                          ? groups.filter((group) => group.repoRoot).map((group) => group.key)
                          : [],
                      ),
                    );
                    toggle(inRange, event.target.checked);
                  }}
                />
                Repositories <span className="onb-n">{shown.length}</span>
              </div>
              <div className="onb-rows onb-scroll">
                <RepositoryRows
                  groups={shown}
                  sessions={sessions}
                  repositories={repositories}
                  toggleRepository={toggleRepository}
                  open={open}
                  setOpen={setOpen}
                  toggle={toggle}
                />
                {!shown.length ? (
                  <p className="onb-hint">
                    {query ? `No repositories match “${query}”.` : "No sessions in this range."}
                  </p>
                ) : null}
              </div>
            </section>
            <p className="onb-hint">
              {plural(chosenRepositories.length, "repository", "repositories")} and{" "}
              {plural(chosenSessions.size, "session")} selected. Sessions stay in{" "}
              {sources.join(" and ") || "your agents"}; Zoltbot only lists them and can resume them.
              {brief ? ` ${plural(brief, "very short session")} hidden.` : ""}{" "}
              <button type="button" className="onb-link" onClick={() => setAdvanced(true)}>
                Choose sources and folders yourself
              </button>
            </p>
          </>
        )}
        {read.isError ? (
          <p role="alert" className="doctor-error">
            Sessions could not be read. Nothing was imported.{" "}
            <button type="button" className="onb-link" onClick={() => read.mutate()}>
              Try again
            </button>
          </p>
        ) : null}
      </>,
      {
        label: chosenSessions.size
          ? `Import ${plural(chosenSessions.size, "session")}`
          : chosenRepositories.length
            ? `Import ${plural(chosenRepositories.length, "repository", "repositories")}`
            : "Next",
        hidden: !items,
        onClick: () => go("tools"),
      },
      () => {
        setSessions(new Set());
        setRepositories(new Set());
        go("tools");
      },
    );
  } else if (step === "tools")
    view = frame(
      "Bring your tools along",
      "MCP servers you already set up. Every connected agent can use the ones you keep.",
      <>
        <section className="card onb-card" aria-label="MCP servers">
          <div className="onb-card-head">
            MCP servers <span className="onb-n">{mcp.length}</span>
          </div>
          <div className="onb-rows">
            {mcp.map((row) => (
              <label key={row.name} className={`onb-row${servers.has(row.name) ? "" : " off"}`}>
                <input
                  type="checkbox"
                  aria-label={`Import ${row.name}`}
                  checked={servers.has(row.name)}
                  onChange={(event) =>
                    setServers((previous) => {
                      const next = new Set(previous);
                      if (event.target.checked) next.add(row.name);
                      else next.delete(row.name);
                      return next;
                    })
                  }
                />
                <span className="onb-logo onb-tool" aria-hidden="true">
                  ⌁
                </span>
                <span className="onb-main">
                  <span className="onb-name">
                    {row.name} {row.sources.length > 1 ? <Chip>Merged</Chip> : null}
                  </span>
                  <span className="onb-meta">{row.sources.map(sourceName).join(" + ")}</span>
                </span>
                <span className="onb-end">
                  {row.secrets.length ? (
                    <span className="onb-secret">{row.secrets.join(", ")} ••••</span>
                  ) : null}
                </span>
              </label>
            ))}
            {!mcp.length ? (
              <p className="onb-hint">
                {items ? "No MCP servers were found." : "Session reading was skipped."}
              </p>
            ) : null}
          </div>
        </section>
        <p className="onb-hint">
          Secret values are never shown or copied. Each server stays off until you confirm its
          settings.
        </p>
      </>,
      {
        label: chosenServers.size ? `Import ${plural(servers.size, "server")}` : "Next",
        onClick: () => go("defaults"),
      },
      () => {
        setServers(new Set());
        go("defaults");
      },
    );
  else if (step === "defaults") {
    const settings = entities.settings ?? [];
    view = frame(
      "How should agents work?",
      "You can change this per project or per agent later.",
      <>
        <fieldset className="onb-choices">
          <legend className="onb-label">Approvals</legend>
          {approvals.map(([value, title, text]) => (
            <label key={value} className="onb-choice">
              <input
                type="radio"
                name="onboarding-approval"
                checked={approval === value}
                onChange={() => setApproval(value)}
              />
              <span>
                <b>
                  {title}{" "}
                  {value === "workspace_write" ? <Chip tone="accent">Recommended</Chip> : null}
                </b>
                <span className="onb-meta">{text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <section className="card onb-card" aria-label="Phone">
          <label className="onb-row onb-toggle">
            <span className="onb-main">
              <span className="onb-name">Answer from my phone</span>
              <span className="onb-meta">
                Pair the Zoltbot app with a code. You can also do this later in Settings.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={phone}
              checked={phone}
              onChange={(event) => setPhone(event.target.checked)}
            />
          </label>
          {phone ? (
            <Devices
              call={connection.call}
              devices={entities.device ?? []}
              relayUrl={String(
                settings.find((setting) => setting.key === "link.relayUrl")?.value ?? "",
              )}
              online={!offline}
            />
          ) : null}
        </section>
        {finish.isError ? (
          <p role="alert" className="doctor-error">
            {finish.error instanceof Error &&
            finish.error.message.includes("definition_private_configuration_required")
              ? "A coding tool needs protected credential configuration first. No credential was copied."
              : "Setup could not be finished. Anything already saved is kept. Try again."}
          </p>
        ) : null}
      </>,
      {
        label: finish.isPending ? "Finishing…" : "Finish setup",
        disabled: !connected.length,
        reason: "Go back and connect at least one agent.",
        onClick: () => finish.mutate(),
      },
    );
  } else {
    const projects = (entities.project ?? []).filter(
      (row) =>
        !row.archived &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        row.name.toLowerCase().includes(projectQuery.trim().toLowerCase()),
    );
    const names = connected.filter((row) => created.current.has(row.id));
    view = (
      <>
        <header className="onb-head">
          <h1 ref={heading} tabIndex={-1}>
            You’re all set
          </h1>
          <p className="onb-sub">Pick a project and tell an agent what to work on.</p>
        </header>
        <div className="onb-summary">
          <div>
            <strong>{names.length}</strong>
            <span>{names.map((row) => row.name).join(", ")}</span>
          </div>
          <div>
            <strong>{imported.toLocaleString()}</strong>
            <span>sessions listed</span>
          </div>
          <div>
            <strong>{servers.size}</strong>
            <span>MCP servers</span>
          </div>
        </div>
        <section className="card onb-card" aria-label="First project">
          <div className="onb-card-head">Pick your first project</div>
          <input
            className="onb-search onb-wide"
            type="search"
            aria-label="Search projects"
            placeholder="Search projects"
            value={projectQuery}
            onChange={(event) => setProjectQuery(event.target.value)}
          />
          <div className="onb-picker" role="radiogroup" aria-label="Projects">
            {[{ id: "", name: "No project" }, ...projects].map((row) => (
              <label key={String(row.id)} className="onb-pick">
                <input
                  type="radio"
                  name="onboarding-project"
                  checked={projectId === row.id}
                  onChange={() => setProjectId(String(row.id))}
                />
                {String(row.name)}
              </label>
            ))}
          </div>
        </section>
        <div className="onb-composer">
          <textarea
            aria-label="First message"
            placeholder="What should we work on?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="onb-composer-row">
            <select
              aria-label="Agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
            >
              {names.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
            <span className="grow" />
            <Button variant="ghost" disabled={busy} onClick={onSkip}>
              Go to workspace
            </Button>
            <Button
              variant="primary"
              disabled={busy || offline || !agent}
              onClick={() => start.mutate()}
            >
              {prompt.trim() ? "Start" : "Open chat"}
            </Button>
          </div>
        </div>
        {start.isError ? (
          <p role="alert" className="doctor-error">
            The conversation could not be started. Your setup is saved. Try again.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <section className="onboarding" aria-label="Workspace setup" aria-busy={busy}>
      {view}
    </section>
  );
}
