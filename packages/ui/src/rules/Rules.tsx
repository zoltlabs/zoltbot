import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { terms } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { ChatConnection, Row } from "../chat/types.js";
import CreateRule, { type ScopeOption } from "./CreateRule.js";
import RulePreview from "./RulePreview.js";
import { matcherLabel, ruleError, rulePage, ruleStatus } from "./rule-data.js";
import "./rules.css";

function options(rows: Row[] = []): ScopeOption[] {
  return rows
    .filter(
      (row) =>
        !row.archived && !row.hidden && typeof row.id === "string" && typeof row.name === "string",
    )
    .map((row) => ({ id: String(row.id), label: String(row.name) }));
}
export default function Rules({ connection }: { connection: ChatConnection }) {
  const cache = useQueryClient(),
    id = useId();
  const [scope, setScope] = useState("all"),
    [state, setState] = useState("active");
  const [cursor, setCursor] = useState<string>(),
    [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const [creating, setCreating] = useState(false),
    [notice, setNotice] = useState("");
  const button = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    savedHeading = useRef<HTMLHeadingElement>(null);
  const revocations = useRef(new Map<string, string>());
  const restoreCreateFocus = useRef(false);
  useEffect(() => {
    if (!creating && restoreCreateFocus.current) {
      restoreCreateFocus.current = false;
      button.current?.focus();
    }
  }, [creating]);
  const entities = connection.snapshot.entities;
  const profiles = options(entities.agent),
    projects = options(entities.project);
  const stamp = JSON.stringify(entities.rule ?? []);
  const seen = useRef(stamp);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    setCursor(undefined);
    setPrevious([]);
    void cache.invalidateQueries({ queryKey: ["approval-rules"] });
  }, [stamp, cache]);
  const list = useQuery({
    queryKey: ["approval-rules", scope, state, cursor ?? null],
    queryFn: async () =>
      rulePage(
        await connection.call("rule.list", {
          limit: 50,
          state,
          ...(scope !== "all" ? { scope } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ),
    enabled: connection.status === "online",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const revoke = useMutation({
    mutationFn: async (ruleId: string) => {
      let command = revocations.current.get(ruleId);
      if (!command) {
        command = crypto.randomUUID();
        revocations.current.set(ruleId, command);
      }
      return connection.call("rule.revoke", { id: ruleId }, command);
    },
    onSuccess: () => {
      setNotice("Rule revoked.");
      savedHeading.current?.focus();
      void cache.invalidateQueries({ queryKey: ["approval-rules"] });
    },
    retry: false,
  });
  const rows = list.data?.items ?? [];
  const tools = [
    ...new Set([
      "execute",
      ...(entities.rule ?? []).flatMap((row) => {
        const matcher = row.matcher as Record<string, unknown> | undefined;
        return matcher?.command && typeof matcher.tool === "string" ? [matcher.tool] : [];
      }),
    ]),
  ];
  function closeForm() {
    restoreCreateFocus.current = true;
    setCreating(false);
  }
  function filter(nextScope: string, nextState: string) {
    setScope(nextScope);
    setState(nextState);
    setCursor(undefined);
    setPrevious([]);
    setNotice("");
  }
  return (
    <section className="rules-page" aria-label="Approval rule settings">
      <header className="rules-heading">
        <div>
          <h1 ref={heading} tabIndex={-1}>
            Approval rules
          </h1>
          <p className="dim">
            Manage saved decisions for {terms.profile.many} and {terms.workspace.many}.
          </p>
        </div>
        <div className="rules-actions">
          <button
            className="btn"
            type="button"
            disabled={list.isFetching || connection.status !== "online"}
            onClick={() => {
              setCursor(undefined);
              setPrevious([]);
              void list.refetch();
            }}
          >
            Refresh
          </button>
          <button
            ref={button}
            className="btn pri"
            type="button"
            disabled={creating || connection.status !== "online"}
            onClick={() => {
              setNotice("");
              setCreating(true);
            }}
          >
            New rule
          </button>
        </div>
      </header>
      {connection.status !== "online" ? (
        <output className="rules-error">Reconnect to manage approval rules.</output>
      ) : null}
      {notice ? <output className="rules-notice">{notice}</output> : null}
      {creating ? (
        <CreateRule
          connection={connection}
          profiles={profiles}
          projects={projects}
          tools={tools}
          onCancel={closeForm}
          onCreated={() => {
            setNotice("Rule created.");
            closeForm();
            void cache.invalidateQueries({ queryKey: ["approval-rules"] });
          }}
        />
      ) : null}
      <RulePreview
        connection={connection}
        profiles={profiles}
        projects={projects}
        tools={tools}
        stamp={stamp}
      />
      <section
        className="card rules-list"
        aria-labelledby={`${id}-saved`}
        aria-busy={list.isFetching || revoke.isPending}
      >
        <div className="rules-list-heading">
          <h2 ref={savedHeading} tabIndex={-1} id={`${id}-saved`}>
            Saved rules
          </h2>
          <div className="rules-filters">
            <div className="rules-field">
              <label htmlFor={`${id}-scope`}>Scope filter</label>
              <select
                id={`${id}-scope`}
                value={scope}
                onChange={(event) => filter(event.target.value, state)}
              >
                <option value="all">All scopes</option>
                <option value="global">Global</option>
                <option value="agent">Profile</option>
                <option value="project">Project</option>
              </select>
            </div>
            <div className="rules-field">
              <label htmlFor={`${id}-state`}>State filter</label>
              <select
                id={`${id}-state`}
                value={state}
                onChange={(event) => filter(scope, event.target.value)}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="all">All states</option>
              </select>
            </div>
          </div>
        </div>
        {list.isError ? (
          <p className="rules-error" role="alert">
            Rules could not be refreshed. Reconnect and refresh to load current rules.
          </p>
        ) : null}
        {revoke.isError ? (
          <p className="rules-error" role="alert">
            {ruleError(revoke.error)}
          </p>
        ) : null}
        {list.isPending && connection.status === "online" ? (
          <output className="dim">Loading rules…</output>
        ) : rows.length ? (
          <>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded table region needs keyboard scrolling at narrow widths. */}
            <section className="rules-table" aria-label="Saved approval rules" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Decision</th>
                    <th scope="col">Command or target</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Expiry</th>
                    <th scope="col">State</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((rule) => {
                    const status = ruleStatus(rule, Date.now());
                    const scopeRows = rule.scope === "agent" ? entities.agent : entities.project;
                    const name = scopeRows?.find((row) => row.id === rule.scopeId)?.name;
                    const scopeName =
                      rule.scope === "global"
                        ? "Global"
                        : `${rule.scope === "agent" ? terms.profile.One : terms.workspace.One}: ${typeof name === "string" ? name : (rule.scopeId ?? "Unavailable")}`;
                    return (
                      <tr key={rule.id}>
                        <td>
                          <span className={`chip ${rule.decision === "allow" ? "ok" : "bad"}`}>
                            {rule.decision === "allow" ? "Allow" : "Deny"}
                          </span>
                        </td>
                        <td>
                          <code dir="ltr">{matcherLabel(rule)}</code>
                          <span className="rules-meta">
                            <bdi>{rule.matcher.tool}</bdi>
                          </span>
                        </td>
                        <td>
                          <bdi>{scopeName}</bdi>
                        </td>
                        <td>
                          {rule.expiresAt ? (
                            <time dateTime={rule.expiresAt}>
                              {new Date(rule.expiresAt).toLocaleString()}
                            </time>
                          ) : (
                            "No expiry"
                          )}
                        </td>
                        <td>
                          <span className={`chip${status === "Active" ? " acc" : ""}`}>
                            {status}
                          </span>
                        </td>
                        <td>
                          {status === "Active" ? (
                            <button
                              className="btn"
                              type="button"
                              disabled={revoke.isPending || connection.status !== "online"}
                              onClick={() => {
                                setNotice("");
                                revoke.mutate(rule.id);
                              }}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span className="dim">Closed</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
            <div className="rules-paging">
              <span className="dim">{rows.length} rules on this page</span>
              <button
                className="btn"
                type="button"
                disabled={!previous.length || list.isFetching || connection.status !== "online"}
                onClick={() => {
                  setCursor(previous.at(-1));
                  setPrevious((current) => current.slice(0, -1));
                }}
              >
                Previous page
              </button>
              <button
                className="btn"
                type="button"
                disabled={!list.data?.cursor || list.isFetching || connection.status !== "online"}
                onClick={() => {
                  setPrevious((current) => [...current, cursor]);
                  setCursor(list.data?.cursor);
                }}
              >
                Next page
              </button>
            </div>
          </>
        ) : !list.isError ? (
          <p className="rules-empty dim">No rules match these filters.</p>
        ) : null}
      </section>
    </section>
  );
}
