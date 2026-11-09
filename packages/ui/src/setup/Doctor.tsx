import { useMutation, useQuery } from "@tanstack/react-query";
import type { ChatConnection } from "../chat/types.js";
import {
  capabilityRows,
  doctorChecks,
  label,
  loginLabel,
  record,
  stateLabel,
  supportLabel,
} from "./doctor-data.js";
import "./setup.css";

export default function Doctor({
  connection,
  onSetup,
}: {
  connection: ChatConnection;
  onSetup(): void;
}) {
  const report = useQuery({
    queryKey: ["doctor-report"],
    queryFn: async () => doctorChecks(await connection.call("doctor.report", {})),
    enabled: connection.status === "online",
    retry: false,
    refetchOnWindowFocus: false,
  });
  const scan = useMutation({
    mutationFn: async () => {
      await connection.call("detect.scan", {});
      await report.refetch({ throwOnError: true });
    },
  });
  const checks = report.data ?? [],
    agents = checks.filter((row) => row.kind === "agent");
  const pending = report.isFetching || scan.isPending;
  const notices = [
    ...new Map(
      checks
        .filter((row) => ["change", "definition"].includes(String(row.kind)))
        .map((row) => [JSON.stringify(row), row]),
    ).values(),
  ];
  return (
    <section className="doctor-page" aria-label="Coding agent diagnostics" aria-busy={pending}>
      <header className="doctor-heading">
        <div>
          <h2>Coding agents</h2>
          <p className="dim">
            See which coding tools are connected and check your local workspace.
          </p>
        </div>
        <div className="r wrap">
          <button className="btn" type="button" onClick={onSetup}>
            Open workspace setup
          </button>
          <button
            className="btn pri"
            type="button"
            disabled={pending || connection.status !== "online"}
            onClick={() => scan.mutate()}
          >
            {scan.isPending ? "Scanning coding tools…" : "Scan coding tools"}
          </button>
        </div>
      </header>
      {pending ? (
        <output className="doctor-status">
          {scan.isPending
            ? "Checking installed tools and login state. No model prompt is sent."
            : "Loading diagnostics…"}
        </output>
      ) : null}
      {report.isError || scan.isError ? (
        <p role="alert" className="doctor-error">
          Diagnostics could not be refreshed. Previous results are kept. Reconnect and run the
          checks again.
        </p>
      ) : null}
      {report.dataUpdatedAt ? (
        <p className="sm dim">
          Last report: {new Date(report.dataUpdatedAt).toLocaleTimeString()}. Run the scan again
          after changing an install.
        </p>
      ) : null}
      {agents.length ? (
        <div className="doctor-agents">
          {agents.map((agent) => {
            const install = record(agent.install),
              selected = record(install.selected);
            const candidates = Array.isArray(install.candidates)
              ? install.candidates.map(record)
              : [];
            const runtime = record(agent.runtime);
            return (
              <article
                className="card doctor-tool"
                key={label(agent.definitionId)}
                aria-label={`${label(agent.displayName)} diagnostics`}
              >
                <header>
                  <h3>{label(agent.displayName)}</h3>
                  <span className="chip">{loginLabel(agent.login)}</span>
                </header>
                <dl className="doctor-facts">
                  <div>
                    <dt>Install</dt>
                    <dd>
                      {typeof selected.path === "string" ? (
                        <>
                          <code>{selected.path}</code>
                          <br />
                          {label(selected.version, "Version unknown")} ·{" "}
                          {supportLabel(selected.support)}
                        </>
                      ) : agent.unavailableReason === "unverified_integration" ? (
                        "Integration not verified"
                      ) : (
                        "Not found"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>{stateLabel(runtime.state)}</dd>
                  </div>
                  <div>
                    <dt>Host tools</dt>
                    <dd>{stateLabel(agent.hostTools)}</dd>
                  </div>
                  {agent.overridden === true ? (
                    <div>
                      <dt>Definition</dt>
                      <dd>User override</dd>
                    </div>
                  ) : null}
                </dl>
                {candidates.length > 1 ||
                candidates.some((candidate) => candidate.state === "broken") ? (
                  <details>
                    <summary>All detected installs ({candidates.length})</summary>
                    <ul>
                      {candidates.map((candidate) => (
                        <li key={label(candidate.path)}>
                          <code>{label(candidate.path)}</code>
                          <br />
                          {candidate.state === "broken"
                            ? "Ignored: broken install"
                            : candidate.path === selected.path
                              ? "Selected install"
                              : "Alternative install"}{" "}
                          · {label(candidate.version, "Version unknown")}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <details>
                  <summary>Declared capabilities</summary>
                  <p className="sm dim">
                    From the tool definition. A native connection must confirm runtime support.
                  </p>
                  <dl className="doctor-capabilities">
                    {capabilityRows(agent.capabilities).map(([name, value]) => (
                      <div key={name}>
                        <dt>{name}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </article>
            );
          })}
        </div>
      ) : !pending && !report.isError ? (
        <section className="card doctor-empty">
          <h3>No tool checks yet</h3>
          <p>Scan coding tools to find installed binaries and check their login state.</p>
        </section>
      ) : null}
      {checks.some((row) => row.kind === "global") ? (
        <section className="card doctor-global" aria-label="Workspace checks">
          <h3>Workspace checks</h3>
          <dl>
            {checks
              .filter((row) => row.kind === "global")
              .map((row) => (
                <div key={label(row.id)}>
                  <dt>{stateLabel(row.id, "Check")}</dt>
                  <dd>
                    {stateLabel(row.state)}
                    {typeof row.version === "string" ? ` · ${row.version}` : ""}
                    {typeof row.availableBytes === "number"
                      ? ` · ${(row.availableBytes / 1024 ** 3).toFixed(1)} GiB free`
                      : ""}
                  </dd>
                </div>
              ))}
          </dl>
        </section>
      ) : null}
      {notices.length ? (
        <section className="card doctor-global" aria-label="Diagnostic notices">
          <h3>Changes and definition notices</h3>
          <ul>
            {notices.map((row) => (
              <li key={JSON.stringify(row)}>
                {label(row.definitionId, label(row.file, "Definition"))} ·{" "}
                {stateLabel(row.code, "Needs a check")}
                {typeof row.from === "string" && typeof row.to === "string"
                  ? `: ${row.from} → ${row.to}`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
