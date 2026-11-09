import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { Button, Chip, Menu } from "../components/primitives.js";
import {
  type AgentRow,
  outsideRepository,
  type SessionGroup,
  sessionTitle,
  sourceName,
} from "./onboarding-data.js";

export const when = (time?: number) =>
  time ? new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
/** Two letters so Claude Code, Codex and Cursor stay distinct: CC, Co, Cu. */
export const monogram = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 1
    ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase()
    : name.slice(0, 2);
};
export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

type Toggle = (ids: string[], on: boolean) => void;
const flip = (set: ReadonlySet<string>, id: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

export function AgentRows({
  rows,
  selected,
  setSelected,
  disabled,
  signingIn,
  onSignIn,
  onInstallHelp,
}: {
  rows: AgentRow[];
  selected: ReadonlySet<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  disabled: boolean;
  signingIn: boolean;
  onSignIn(id: string): void;
  onInstallHelp(): void;
}) {
  return (
    <>
      {rows.map((row) => (
        <label key={row.id} className={`onb-row${selected.has(row.id) ? "" : " off"}`}>
          <input
            type="checkbox"
            aria-label={`Use ${row.name}`}
            checked={row.ready && selected.has(row.id)}
            disabled={!row.ready || disabled}
            onChange={(event) =>
              setSelected((previous) => flip(previous, row.id, event.target.checked))
            }
          />
          <span
            className="onb-logo"
            aria-hidden="true"
            style={
              selected.has(row.id)
                ? { borderColor: `var(--zb-provider-${row.id}, var(--zb-border-strong))` }
                : undefined
            }
          >
            {monogram(row.name)}
          </span>
          <span className="onb-main">
            <span className="onb-name">{row.name}</span>
            <span className="onb-meta">
              {row.path
                ? `${row.version ?? "Version unknown"} · ${row.plan ?? row.path}`
                : "Not found on this Mac"}
            </span>
            {row.broken ? (
              <span className="onb-meta">{plural(row.broken, "broken install")} ignored</span>
            ) : null}
          </span>
          <span className="onb-end">
            {!row.path ? (
              <Button size="sm" onClick={onInstallHelp}>
                Install help
              </Button>
            ) : row.login === "signed_out" ? (
              <>
                <Chip tone="attention">Signed out</Chip>
                <Button
                  size="sm"
                  disabled={signingIn}
                  onClick={(event) => {
                    event.preventDefault();
                    onSignIn(row.id);
                  }}
                >
                  Sign in
                </Button>
              </>
            ) : row.login === "unknown" ? (
              <Chip>Login unknown</Chip>
            ) : (
              <Chip tone="ok">Ready</Chip>
            )}
          </span>
        </label>
      ))}
    </>
  );
}

export function RepositoryRows({
  groups,
  sessions,
  repositories,
  toggleRepository,
  open,
  setOpen,
  toggle,
}: {
  groups: SessionGroup[];
  sessions: ReadonlySet<string>;
  repositories: ReadonlySet<string>;
  toggleRepository(group: SessionGroup, on: boolean): void;
  open: ReadonlySet<string>;
  setOpen: Dispatch<SetStateAction<Set<string>>>;
  toggle: Toggle;
}) {
  return (
    <>
      {groups.map((group) => {
        const ids = group.sessions.map((row) => row.id);
        const count = ids.filter((id) => sessions.has(id)).length;
        const expanded = open.has(group.key);
        const selected = group.repoRoot ? repositories.has(group.key) : count > 0;
        return (
          <div key={group.key}>
            <div className={`onb-row onb-repo${selected ? "" : " off"}`}>
              <input
                type="checkbox"
                aria-label={`Import ${group.name}`}
                checked={group.repoRoot ? selected : count === ids.length}
                ref={(element) => {
                  if (element)
                    element.indeterminate = !group.repoRoot && count > 0 && count < ids.length;
                }}
                onChange={(event) => toggleRepository(group, event.target.checked)}
              />
              <span className="onb-main">
                <span className={`onb-name${group.key === outsideRepository ? " onb-loose" : ""}`}>
                  {group.name}
                </span>
              </span>
              <span className="onb-end onb-count">
                {count !== ids.length ? `${count.toLocaleString()} of ` : ""}
                {ids.length.toLocaleString()}
                <Menu
                  label={`Session options for ${group.name}`}
                  items={[
                    { label: "Select all sessions", onSelect: () => toggle(ids, true) },
                    { label: "Deselect all sessions", onSelect: () => toggle(ids, false) },
                  ]}
                />
                <button
                  type="button"
                  className="onb-expand"
                  aria-expanded={expanded}
                  aria-label={`Show sessions in ${group.name}`}
                  onClick={() =>
                    setOpen((previous) => {
                      const next = new Set(previous);
                      if (expanded) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                >
                  ›
                </button>
              </span>
            </div>
            {expanded ? (
              <div className="onb-sessions">
                {group.sessions.slice(0, 50).map((row) => (
                  <label key={row.id} className="onb-session">
                    <input
                      type="checkbox"
                      checked={sessions.has(row.id)}
                      onChange={(event) => toggle([row.id], event.target.checked)}
                    />
                    <span className="onb-title">{sessionTitle(row)}</span>
                    <span className="onb-meta">{sourceName(row.source)}</span>
                    <span className="onb-meta">{when(row.modifiedAt)}</span>
                  </label>
                ))}
                {group.sessions.length > 50 ? (
                  <p className="onb-hint">
                    {plural(group.sessions.length - 50, "more session")} follow the same choice.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** The part of the optional Zoltbot account bridge that setup uses. */
type AccountStatus = {
  configured: boolean;
  signedIn: boolean;
  account?: { user: { name: string } };
};
type AccountBridge = { status(): Promise<AccountStatus>; signIn(): Promise<AccountStatus> };

export function AccountLink() {
  const bridge = (window.zoltDesktop as { account?: AccountBridge } | undefined)?.account;
  const [status, setStatus] = useState<AccountStatus>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void bridge
      ?.status()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [bridge]);
  if (!bridge || !status?.configured) return null;
  if (status.signedIn && status.account)
    return <p className="onb-hint">Signed in to Zoltbot as {status.account.user.name}.</p>;
  return (
    <p className="onb-hint">
      Have a Zoltbot account?{" "}
      <button
        type="button"
        className="onb-link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setStatus(await bridge.signIn());
          } catch {
            /* Signing in is optional; setup continues without it. */
          } finally {
            setBusy(false);
          }
        }}
      >
        Sign in
      </button>{" "}
      to save artifacts online. Optional.
    </p>
  );
}
