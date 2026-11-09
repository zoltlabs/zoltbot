import type { Connection } from "@zoltbot/protocol";
import { terms } from "@zoltbot/protocol";
import { useEffect, useId, useRef, useState } from "react";
import type { Row } from "../chat/types.js";
import { Button, Field, Input } from "../components/primitives.js";
import {
  connectionError,
  permissionDescription,
  sentrySlugPattern,
  serviceMark,
  serviceName,
  supportsManagedConnection,
  usesBroker,
} from "./catalog-data.js";

type Call = (method: string, params: unknown, commandId?: string) => Promise<unknown>;
type Recipe = {
  id: string;
  name: string;
  description: string;
  origin: string;
  documentation: string;
  permissions: string;
  availability: "available" | "registration_required" | "unavailable";
};
type Attempt = { id: string; authorizationUrl: string; destination: string; scopes: string[] };

export function AppCatalog({
  call,
  projects,
  profiles,
  online,
  onChanged,
}: {
  call: Call;
  projects: Row[];
  profiles: Row[];
  online: boolean;
  onChanged(): Promise<void>;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Recipe>();
  const [search, setSearch] = useState("");
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry deliberately reloads the catalog after a failed request or sign-in availability check.
  useEffect(() => {
    let active = true;
    if (!online) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void call("connection.catalog.list", {})
      .then((result) => {
        if (active) {
          setRecipes((result as { items: Recipe[] }).items);
          setError("");
        }
      })
      .catch(() => {
        if (active) setError("Apps could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [call, online, retry]);
  return (
    <div className="app-catalog">
      {selected ? (
        <CatalogConnect
          recipe={selected}
          call={call}
          projects={projects}
          profiles={profiles}
          online={online}
          onChanged={onChanged}
          onClose={() => setSelected(undefined)}
        />
      ) : (
        <>
          <h3>Connect your apps</h3>
          <p className="settings-hint">
            Bring the services you use into your agents’ work. Choose access per{" "}
            {terms.workspace.one} and {terms.profile.one}.
          </p>
          <Field label="Search apps">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps…"
            />
          </Field>
          {loading ? <output aria-live="polite">Loading apps…</output> : null}
          {!online ? <p>Connect to your Mac to browse and connect apps.</p> : null}
          {error ? (
            <p role="alert">
              {error} <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>
            </p>
          ) : null}
          {recipes.some((r) => r.availability === "unavailable") ? (
            <Button disabled={!online || loading} onClick={() => setRetry((n) => n + 1)}>
              Retry sign-in service availability
            </Button>
          ) : null}
          <div className="app-catalog-grid">
            {recipes
              .filter((r) =>
                `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase()),
              )
              .map((recipe) => (
                <article key={recipe.id} className="app-catalog-tile">
                  <div className="app-catalog-heading">
                    <span aria-hidden="true" className={`app-service-mark ${recipe.id}`}>
                      {serviceMark(recipe.id)}
                    </span>
                    <h3>{recipe.name}</h3>
                  </div>
                  <p>{recipe.description}</p>
                  <div className="app-catalog-actions">
                    <span className="settings-hint">
                      {recipe.availability !== "available"
                        ? recipe.availability === "unavailable"
                          ? "Sign-in service unavailable"
                          : "Registration setup needed"
                        : "Browser sign-in"}
                    </span>
                    <Button disabled={!online} onClick={() => setSelected(recipe)}>
                      {recipe.availability !== "available"
                        ? `View ${recipe.name} setup`
                        : `Connect ${recipe.name}`}
                    </Button>
                  </div>
                </article>
              ))}
          </div>
          {!loading &&
          recipes.length > 0 &&
          !recipes.some((r) =>
            `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase()),
          ) ? (
            <p>
              No apps match your search. <Button onClick={() => setSearch("")}>Clear search</Button>
            </p>
          ) : null}

          <p className="settings-hint">
            Credentials stay in your Mac Keychain. Supported native Claude and Codex profiles
            receive tools in new sessions.
          </p>
        </>
      )}
    </div>
  );
}

function CatalogConnect({
  recipe,
  call,
  projects,
  profiles,
  online,
  onChanged,
  onClose,
}: {
  recipe: Recipe;
  call: Call;
  projects: Row[];
  profiles: Row[];
  online: boolean;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const id = useId();
  const [projectId, setProjectId] = useState("");
  const [organization, setOrganization] = useState("");
  const [serviceProject, setServiceProject] = useState("");
  const [item, setItem] = useState<Connection>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [step, setStep] = useState<"setup" | "waiting" | "access" | "done">("setup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tested, setTested] = useState(false);
  const live = useRef(true);
  const pending = useRef<string | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (pending.current)
        void call("connection.auth.cancel", { id: pending.current }, crypto.randomUUID()).catch(
          () => {},
        );
    };
  }, [call]);
  useEffect(() => {
    void step;
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (!attempt || step !== "waiting") return;
    let active = true,
      polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = (await call("connection.auth.status", { id: attempt.id })) as {
          state: string;
        };
        if (!active) return;
        if (result.state === "connected") {
          pending.current = undefined;
          const list = (await call("connection.list", {})) as { items: Connection[] };
          if (!active) return;
          const current = list.items.find((row) => row.id === item?.id);
          if (!current) throw new Error();
          setItem(current);
          setStep("access");
          await onChanged();
        } else if (result.state !== "waiting") {
          pending.current = undefined;
          setStep("setup");
          setAttempt(undefined);
          setError("Sign-in was not completed. Your setup is saved. Try again.");
        }
      } catch {
        if (active)
          setError("Sign-in status could not be checked. Retrying while this page is open.");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [attempt, step, call, item?.id, onChanged]);
  async function start() {
    if (busy || !online || !projectId) return;
    setBusy(true);
    setError("");
    try {
      const installed =
        item ??
        ((await call(
          "connection.install",
          {
            serviceId: recipe.id,
            projectId,
            ...(recipe.id === "sentry"
              ? { organization, serviceProject }
              : recipe.id === "posthog"
                ? { serviceProject }
                : {}),
          },
          crypto.randomUUID(),
        )) as Connection);
      if (!live.current) return;
      setItem(installed);
      await onChanged();
      const next = (await call(
        "connection.auth.start",
        { id: installed.id, confirmed: true },
        crypto.randomUUID(),
      )) as Attempt;
      if (!live.current) {
        await call("connection.auth.cancel", { id: next.id }, crypto.randomUUID());
        return;
      }
      pending.current = next.id;
      setAttempt(next);
      setStep("waiting");
    } catch (failure) {
      if (live.current) setError(connectionError(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function saveAccess() {
    if (!item || busy || !online) return;
    setBusy(true);
    setError("");
    try {
      const saved = (await call(
        "connection.save",
        {
          value: { ...item, enabled: item.profileIds.length > 0 },
          expectedVersion: item.version,
          confirmed: true,
        },
        crypto.randomUUID(),
      )) as Connection;
      setItem(saved);
      setStep("done");
      await onChanged();
    } catch (failure) {
      setError(connectionError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="app-connect" aria-labelledby={`${id}-title`}>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        ← Back to apps
      </Button>
      <div className="app-catalog-heading">
        <span className={`app-service-mark ${recipe.id}`} aria-hidden="true">
          {serviceMark(recipe.id)}
        </span>
        <div>
          <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
            {step === "done" ? `${recipe.name} connected` : `Connect ${recipe.name}`}
          </h3>
          <p className="settings-hint">Official hosted service · Claude and Codex</p>
        </div>
      </div>
      <ol className="app-connect-steps" aria-label="Connection steps">
        {["Set up", "Sign in", "Allow access"].map((label, index) => (
          <li
            key={label}
            aria-current={
              (step === "setup" ? 0 : step === "waiting" ? 1 : 2) === index ? "step" : undefined
            }
          >
            {index + 1} · {label}
          </li>
        ))}
      </ol>
      {error ? <p role="alert">{error}</p> : null}
      {!online ? <output>Connect to your Mac to continue.</output> : null}
      {step === "setup" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <Field label={`Zoltbot ${terms.workspace.one}`}>
            <select
              aria-label={`Zoltbot ${terms.workspace.one}`}
              required
              value={projectId}
              disabled={busy || !!item}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Choose {terms.workspace.one}</option>
              {projects
                .filter((p) => !p.archived)
                .map((p) => (
                  <option key={String(p.id)} value={String(p.id)}>
                    {String(p.name)}
                  </option>
                ))}
            </select>
          </Field>
          {recipe.id === "sentry" ? (
            <>
              <Field
                label="Sentry organization"
                hint="Organization slug from your Sentry project URL."
              >
                <Input
                  required
                  pattern={sentrySlugPattern}
                  value={organization}
                  disabled={busy || !!item}
                  onChange={(e) => setOrganization(e.target.value)}
                  placeholder="example"
                />
              </Field>
              <Field label="Sentry project" hint="The connection is restricted to this project.">
                <Input
                  required
                  pattern={sentrySlugPattern}
                  value={serviceProject}
                  disabled={busy || !!item}
                  onChange={(e) => setServiceProject(e.target.value)}
                  placeholder="web-app"
                />
              </Field>
            </>
          ) : null}
          {recipe.id === "posthog" ? (
            <Field
              label="PostHog project ID"
              hint="Numeric ID from PostHog project settings. This pins MCP context."
            >
              <Input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]{0,19}"
                value={serviceProject}
                disabled={busy || !!item}
                onChange={(e) => setServiceProject(e.target.value)}
                placeholder="12345"
              />
            </Field>
          ) : null}
          {recipe.availability !== "available" ? (
            <div className="app-connect-note">
              <strong>
                {recipe.availability === "unavailable"
                  ? "Sign-in service unavailable"
                  : "Registration setup required"}
              </strong>
              <p>
                {recipe.availability === "unavailable"
                  ? "The sign-in service could not be reached or is not deployed yet. Return to the catalog and retry availability."
                  : "Zoltbot’s registered application must be configured and approved before this service can sign in. Your organization may also need to allow the app."}
              </p>
            </div>
          ) : null}
          <div className="app-connect-note">
            <strong>{recipe.permissions}</strong>
            <p>{permissionDescription(recipe.id)}</p>
            {usesBroker(recipe.id) ? (
              <p>
                Zoltbot securely exchanges authorization codes and refresh requests. API calls go
                directly from your Mac to the service. No Zoltbot login is required.
              </p>
            ) : null}
            <p>Destination: {recipe.origin}. Credentials are stored in your Mac Keychain.</p>
          </div>
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !online || !projectId || recipe.availability !== "available"}
          >
            {busy ? "Preparing secure sign-in…" : "Continue to sign-in"}
          </Button>
          <a href={recipe.documentation} target="_blank" rel="noreferrer">
            Official {recipe.name} information ↗
          </a>
        </form>
      ) : null}
      {step === "waiting" && attempt ? (
        <>
          <output>
            Waiting for {recipe.name}. Choose your account and approve access in your browser.
          </output>
          <a
            className="app-browser-link"
            href={attempt.authorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            Continue in browser ↗
          </a>
          <p className="settings-hint">
            Authorization destination: {attempt.destination}. Return here after sign-in.
          </p>
          <Button
            disabled={!online}
            onClick={() => {
              void call("connection.auth.cancel", { id: attempt.id }, crypto.randomUUID())
                .then(() => {
                  pending.current = undefined;
                  setStep("setup");
                  setAttempt(undefined);
                  setError("Sign-in cancelled. Your setup is saved.");
                })
                .catch((failure) => setError(connectionError(failure)));
            }}
          >
            Cancel sign-in
          </Button>
        </>
      ) : null}
      {step === "access" && item ? (
        <>
          <div className="app-connect-note">
            <strong>Signed in through {recipe.name}</strong>
            <p>
              The service account was chosen in your browser. Account identity is not reported here;
              confirm you selected the intended account before allowing access.
            </p>
            <p>
              {recipe.id === "sentry"
                ? `Project: ${organization} / ${serviceProject} · Capabilities approved in Sentry`
                : recipe.id === "posthog"
                  ? `PostHog project ${serviceProject} · Read-only MCP tools`
                  : recipe.permissions}
            </p>
          </div>
          <fieldset>
            <legend>
              Profiles that can use this in{" "}
              {String(projects.find((p) => p.id === projectId)?.name ?? terms.workspace.one)}
            </legend>
            {profiles
              .filter((p) => !p.archived)
              .map((profile) => (
                <label key={String(profile.id)} className="app-profile-choice">
                  <input
                    type="checkbox"
                    checked={item.profileIds.includes(String(profile.id))}
                    disabled={!supportsManagedConnection(profile.definitionId)}
                    onChange={(e) =>
                      setItem({
                        ...item,
                        profileIds: e.target.checked
                          ? [...item.profileIds, String(profile.id)]
                          : item.profileIds.filter((p) => p !== profile.id),
                      })
                    }
                  />
                  <span>
                    {String(profile.name)}
                    {!supportsManagedConnection(profile.definitionId)
                      ? " · Managed apps unavailable for this provider"
                      : ""}
                  </span>
                </label>
              ))}
          </fieldset>
          <p className="settings-hint">
            Only supported Claude and Codex profiles receive these tools. Changes apply to new
            sessions. Allowing access does not bypass tool approvals.
          </p>
          <Button
            variant="primary"
            disabled={busy || !online}
            onClick={() => {
              void saveAccess();
            }}
          >
            {busy
              ? "Saving access…"
              : item.profileIds.length
                ? "Allow access"
                : "Save without profile access"}
          </Button>
        </>
      ) : null}
      {step === "done" && item ? (
        <>
          <output>
            {item.profileIds.length
              ? "Available to selected profiles in new sessions."
              : "Connected. No profiles are allowed yet."}
          </output>
          <div className="app-connect-note">
            <strong>{serviceName(item.source)}</strong>
            <p>{item.transport.kind === "https" ? item.transport.url : ""}</p>
            <p>
              {tested
                ? "Protocol check passed. Individual tool health has not been reported."
                : "Sign-in completed. Connection health has not been checked."}
            </p>
          </div>
          <Button
            disabled={busy || !online}
            onClick={() => {
              setBusy(true);
              setError("");
              void call("connection.test", { id: item.id }, crypto.randomUUID())
                .then(() => {
                  setTested(true);
                  return onChanged();
                })
                .catch((failure) => setError(connectionError(failure)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Checking…" : "Check connection"}
          </Button>
          <Button onClick={onClose}>Back to connections</Button>
        </>
      ) : null}
    </section>
  );
}
