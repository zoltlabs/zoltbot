import type { ArtifactManifest } from "@zoltbot/protocol";
import { useEffect, useState } from "react";
import { Button } from "../components/primitives.js";
import type { OnlineArtifact } from "../connection.js";

export function SaveOnline({
  manifest,
  hash,
  title,
  version,
  held,
}: {
  manifest: ArtifactManifest;
  hash: string;
  title: string;
  version: number;
  held: boolean;
}) {
  const bridge = window.zoltDesktop?.account;
  const [org, setOrg] = useState<{ id: string; name: string }>();
  const [online, setOnline] = useState<OnlineArtifact | null>(null);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState<"upload" | "public" | "private">();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    void generation;
    setBusy(true);
    setOnline(null);
    setError("");
    setMessage("");
    setConfirmation(undefined);
    async function load() {
      if (!bridge) return;
      const status = await bridge.status();
      const available = Boolean(
        status.configured && status.signedIn && status.account?.capabilities?.privateArtifacts,
      );
      if (!active) return;
      setAvailable(available);
      setOrg(status.account?.organizations[0]);
      if (available) {
        const snapshot = await bridge.findArtifact(hash, title);
        if (active) setOnline(snapshot);
      }
    }
    void load()
      .catch(() => {
        if (active) setError("Could not check the online copy. Refresh to try again.");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [bridge, hash, title, generation]);
  if (!bridge || !available) return null;
  async function confirm() {
    if (!bridge || !confirmation || !org) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result =
        confirmation === "upload"
          ? await bridge.uploadArtifact({ hash, title, orgId: org.id, confirm: true })
          : online &&
            (await bridge.setArtifactVisibility({
              id: online.id,
              hash,
              title,
              visibility: confirmation,
              confirm: true,
            }));
      if (result) setOnline(result);
      setConfirmation(undefined);
    } catch {
      setError(
        confirmation === "upload"
          ? "Could not save online. Possible secrets are blocked. You can retry this version."
          : "Could not change visibility. Refresh to check the current state before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!bridge || !online) return;
    setBusy(true);
    setError("");
    try {
      await bridge.copyArtifactLink(online.id);
      setMessage("Link copied.");
    } catch {
      setError(
        "Could not copy the link. Refresh to check that this online copy is still available.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Online artifact sharing" className="zb-card artifact-online-sharing">
      {online ? (
        <>
          <p>
            <strong>{online.visibility === "public" ? "Public" : "Private"}</strong> · Version{" "}
            {version}
          </p>
          <p>
            {online.visibility === "public"
              ? "Anyone with the link can view this snapshot."
              : "Only your signed-in account can view this snapshot."}
          </p>
          <p style={{ overflowWrap: "anywhere" }}>{online.url}</p>
          <Button
            size="sm"
            disabled={busy || (held && online.visibility === "private")}
            onClick={() => {
              setMessage("");
              setConfirmation(online.visibility === "private" ? "public" : "private");
            }}
          >
            {online.visibility === "private" ? "Publish publicly" : "Make private"}
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void copy()}>
            Copy link
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          disabled={held || busy || Boolean(error)}
          onClick={() => setConfirmation("upload")}
        >
          Save privately online
        </Button>
      )}
      <Button size="sm" disabled={busy} onClick={() => setGeneration((value) => value + 1)}>
        Refresh online status
      </Button>
      {error && <p role="alert">{error}</p>}
      {message && <output>{message}</output>}
      {confirmation && (
        <section
          role="alertdialog"
          aria-label={
            confirmation === "upload"
              ? "Confirm private artifact upload"
              : confirmation === "public"
                ? "Confirm public artifact publication"
                : "Confirm private artifact visibility"
          }
        >
          <h3>
            {confirmation === "upload"
              ? `Save ${title}, version ${version}, online?`
              : confirmation === "public"
                ? `Publish ${title}, version ${version}, publicly?`
                : "Make this snapshot private?"}
          </h3>
          {confirmation === "private" ? (
            <p>Anonymous access will stop. Previously downloaded copies cannot be recalled.</p>
          ) : (
            <>
              <p>
                {confirmation === "upload"
                  ? `Destination: ${org?.name ?? "Your account"}. New copies are private. If this version is already online, its current visibility is kept.`
                  : "Anyone with the link will be able to view this exact saved version without signing in."}
              </p>
              <p>
                {manifest.files.length} files,{" "}
                {manifest.files.reduce((sum, file) => sum + file.bytes, 0).toLocaleString()} bytes.
              </p>
              <ul>
                {manifest.files.map((file) => (
                  <li key={file.path}>
                    {file.path} · {file.bytes.toLocaleString()} bytes
                  </li>
                ))}
              </ul>
              {manifest.kit && (
                <p>The versioned Zoltbot artifact kit will be served with this copy.</p>
              )}
              <p>
                Your project, conversation and other versions stay on this Mac. New local edits will
                not update this snapshot.
              </p>
            </>
          )}
          <Button disabled={busy} onClick={() => void confirm()}>
            {busy
              ? "Saving…"
              : confirmation === "upload"
                ? "Confirm upload"
                : confirmation === "public"
                  ? "Confirm publication"
                  : "Confirm private"}
          </Button>
          <Button disabled={busy} onClick={() => setConfirmation(undefined)}>
            Cancel
          </Button>
        </section>
      )}
    </section>
  );
}
