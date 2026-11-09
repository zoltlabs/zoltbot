import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ChatConnection, Row } from "../chat/types.js";
import { Button, IconButton } from "../components/primitives.js";
import { Icon } from "../shell/icons.js";
import { updateRows, visibleUpdates } from "./update-data.js";
import "./setup.css";

const hour = 60 * 60 * 1000;

/** One card at a time for a coding tool with a newer published release. */
export function UpdateNotice({
  connection,
  settings,
}: {
  connection: ChatConnection;
  settings: Row[];
}) {
  const client = useQueryClient();
  const online = connection.status === "online";
  const updates = useQuery({
    queryKey: ["cli-updates"],
    queryFn: async () => updateRows(await connection.call("update.list", {})),
    enabled: online,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: hour,
  });
  const [copied, setCopied] = useState(false);
  const dismissed = settings.find((row) => row.key === "updates.dismissed")?.value;
  const update = visibleUpdates(updates.data ?? [], dismissed)[0];
  const run = useMutation({
    mutationFn: async (definitionId: string) =>
      connection.call("update.run", { definitionId, confirmed: true }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["cli-updates"] }),
        client.invalidateQueries({ queryKey: ["doctor-report"] }),
      ]);
    },
  });
  if (!update) return null;
  const command = update.command.join(" ");
  const failed = run.isError && run.variables === update.definitionId;
  const dismiss = async () => {
    const current = dismissed && typeof dismissed === "object" ? dismissed : {};
    await connection.call(
      "settings.set",
      {
        key: "updates.dismissed",
        value: { ...current, [update.definitionId]: update.latest },
      },
      crypto.randomUUID(),
    );
  };
  return (
    <section
      className="update-notice"
      aria-label={`${update.displayName} update available`}
      aria-busy={run.isPending}
    >
      <header>
        <span className="update-notice-icon" aria-hidden="true">
          <Icon name="Update" size="lg" />
        </span>
        <h2>{update.displayName} update available</h2>
        <IconButton
          label={`Dismiss ${update.displayName} ${update.latest}`}
          icon="Close"
          size="sm"
          disabled={run.isPending}
          onClick={() => void dismiss()}
        />
      </header>
      <p className="dim">
        Newer versions bring bug fixes, new models and features. Zoltbot runs <code>{command}</code>
        .
      </p>
      {failed ? (
        <p role="alert" className="update-notice-error">
          The update did not finish. Run <code>{command}</code> in a terminal, then scan coding
          tools in Doctor.{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(command).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy command"}
          </Button>
        </p>
      ) : null}
      <footer>
        <span className="update-notice-versions">
          {update.installed} <span aria-hidden="true">→</span>
          <span className="sr-only">to</span> <strong>{update.latest}</strong>
        </span>
        <Button
          variant="secondary"
          disabled={run.isPending || !online}
          onClick={() => {
            setCopied(false);
            run.mutate(update.definitionId);
          }}
        >
          {run.isPending ? "Updating…" : "Update"}
        </Button>
      </footer>
    </section>
  );
}

/** Settings switch for the once a day release lookup. */
export function UpdateSettings({
  connection,
  settings,
}: {
  connection: ChatConnection;
  settings: Row[];
}) {
  const enabled = settings.find((row) => row.key === "updates.check")?.value !== false;
  const [error, setError] = useState(false);
  return (
    <div className="c">
      <label className="r">
        <input
          type="checkbox"
          checked={enabled}
          disabled={connection.status !== "online"}
          onChange={() => {
            setError(false);
            connection
              .call("settings.set", { key: "updates.check", value: !enabled }, crypto.randomUUID())
              .catch(() => setError(true));
          }}
        />{" "}
        Check for coding tool updates once a day
      </label>
      <span className="settings-hint">
        Asks each provider's release server or npm for its latest version. Nothing about your work
        is sent.
      </span>
      {error ? <p role="alert">Could not save this setting. Reconnect and try again.</p> : null}
    </div>
  );
}
