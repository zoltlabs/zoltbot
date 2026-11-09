import { useState } from "react";
import { type ChatConnection, text } from "./types.js";
export function ProviderAccess({
  connection,
  profileId,
  provider,
}: {
  connection: ChatConnection;
  profileId: string;
  provider: string;
}) {
  const [info, setInfo] = useState<{ command: string; configDirectory: string } | undefined>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [copied, setCopied] = useState(false);
  const definition = connection.snapshot.entities.agentDefinition?.find(
    (row) => row.id === provider || row.flavor === provider,
  );
  const label = text(definition?.displayName) || provider;
  const auth = definition?.auth as { loginCommand?: unknown } | undefined;
  if (
    !Array.isArray(auth?.loginCommand) &&
    !["claude", "codex"].includes(text(definition?.adapter))
  )
    return null;
  return (
    <section className="chat-context-section" aria-label="Provider sign-in">
      <h3>{label} sign-in</h3>
      <p className="dim sm">
        Zoltbot uses your existing coding tool sign-in. Reconnect this chat to use it.
      </p>
      {info ? (
        <>
          <p className="sm">
            If your coding tool needs a fresh sign-in, run this command in your terminal, then
            reconnect.
          </p>
          <pre className="chat-command">
            <code>{info.command}</code>
          </pre>
          <p className="dim sm">
            Provider folder: <code className="chat-path">{info.configDirectory}</code>
          </p>
          <button
            type="button"
            className="btn sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(info.command);
                setCopied(true);
              } catch {
                setError("Could not copy. Select the command above to copy it.");
              }
            }}
          >
            {copied ? "Copied" : "Copy sign-in command"}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn sm"
          disabled={pending || connection.status !== "online"}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              const result = await connection.call("provider.loginInfo", { profileId });
              const value = result as Record<string, unknown>;
              if (!text(value?.command) || !text(value?.configDirectory))
                throw new Error("missing_login_info");
              setInfo({
                command: text(value.command),
                configDirectory: text(value.configDirectory),
              });
            } catch {
              setError(
                "Sign-in instructions are unavailable. Check that this coding tool is installed and its executable works.",
              );
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Checking provider…" : "Show sign-in command"}
        </button>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
