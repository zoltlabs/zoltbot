import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Credentials, parseCredentials as credentials } from "@zoltbot/cloud-contracts";
import { possibleSecret } from "../../../packages/daemon/src/artifacts/intake.js";
import { validateManifest } from "../../../packages/daemon/src/artifacts/model.js";
import {
  type ArtifactManifest,
  ArtifactManifestSchema,
  parse,
} from "../../../packages/protocol/src/index.js";

interface SecretStore {
  put(value: unknown): Promise<{ reference: string }>;
  read(reference: string): Promise<unknown>;
  replace(reference: string, value: unknown): Promise<void>;
  remove(reference: string): Promise<void>;
}
export interface CloudAccountOptions {
  origin?: string;
  referenceFile: string;
  secrets: SecretStore;
  openBrowser(url: string): Promise<void>;
  deviceName: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  writeClipboard?(text: string): void;
  readArtifact?(kind: "manifest" | "blob", hash: string): Promise<Buffer>;
}

/** Main-process boundary. IPC methods only return public metadata, never credentials. */
export function cloudAccount(options: CloudAccountOptions) {
  const send = options.fetch ?? fetch;
  const origin = options.origin;
  if (origin) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      throw new Error("invalid_account_origin");
  }
  let reference: string | undefined;
  let tokens: Credentials | undefined;
  let pending: { server: Server; cancel(): void } | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action, action);
    queue = next.catch(() => {});
    return next;
  }
  const endpoint = (path: string) => {
    if (!origin) throw new Error("accounts_not_configured");
    return `${origin}/api/account${path}`;
  };
  async function load() {
    if (tokens) return tokens;
    try {
      reference = (await readFile(options.referenceFile, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    tokens = credentials(await options.secrets.read(reference));
    return tokens;
  }
  async function save(value: Credentials) {
    if (reference) await options.secrets.replace(reference, value);
    else {
      const next = await options.secrets.put(value);
      const temporary = `${options.referenceFile}.tmp`;
      try {
        await writeFile(temporary, next.reference, { mode: 0o600 });
        await rename(temporary, options.referenceFile);
      } catch (error) {
        await options.secrets.remove(next.reference);
        throw error;
      }
      reference = next.reference;
    }
    tokens = value;
  }
  async function clear() {
    if (reference) await options.secrets.remove(reference);
    await rm(options.referenceFile, { force: true });
    reference = undefined;
    tokens = undefined;
  }
  async function request(path: string, method = "GET", payload?: string | Buffer) {
    const current = await load();
    if (!current) throw new Error("sign_in_required");
    const perform = () =>
      send(endpoint(path), {
        method,
        headers: {
          Authorization: `Bearer ${tokens?.accessToken}`,
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": Buffer.isBuffer(payload)
                  ? "application/octet-stream"
                  : "application/json",
              }),
        },
        ...(payload === undefined
          ? {}
          : { body: Buffer.isBuffer(payload) ? Uint8Array.from(payload) : payload }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
    let response = await perform();
    if (response.status === 401) {
      const rotated = await send(endpoint("/session/refresh"), {
        method: "POST",
        headers: { Authorization: `Refresh ${current.refreshToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!rotated.ok) {
        if (rotated.status === 401) await clear();
        throw new Error(
          rotated.status === 401 ? "sign_in_required" : "account_service_unavailable",
        );
      }
      // Persist rotation before issuing another request. A crash cannot reuse an old in-memory token.
      await save(credentials(await rotated.json()));
      response = await perform();
    }
    if (!response.ok) throw new Error("account_service_unavailable");
    return response.json();
  }
  function artifactId(id: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))
      throw new Error("invalid_artifact_id");
    return id;
  }
  async function localManifest(manifestHash: string) {
    if (!options.readArtifact || !/^[a-f0-9]{64}$/.test(manifestHash))
      throw new Error("invalid_artifact_hash");
    const bytes = await options.readArtifact("manifest", manifestHash);
    if (createHash("sha256").update(bytes).digest("hex") !== manifestHash)
      throw new Error("artifact_corrupt");
    const manifest = parse(ArtifactManifestSchema, JSON.parse(bytes.toString("utf8")));
    validateManifest(manifest);
    return {
      manifest,
      digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    };
  }
  async function onlineArtifact(id: string, digest?: string, title?: string) {
    const view = (await request(`/artifacts/${artifactId(id)}/view`)) as {
      title: string;
      manifestHash: string;
      visibility: string;
    };
    if ((digest && view.manifestHash !== digest) || (title && view.title !== title))
      throw new Error("artifact_version_mismatch");
    if (view.visibility !== "private" && view.visibility !== "public")
      throw new Error("invalid_artifact_response");
    // Never send the content capability from /view across renderer IPC.
    return { id, visibility: view.visibility as "private" | "public", url: `${origin}/s/${id}` };
  }
  async function findArtifact(manifestHash: string, title: string) {
    const { digest } = await localManifest(manifestHash);
    const list = (await request("/artifacts")) as { artifacts: { id: string; title: string }[] };
    for (const item of list.artifacts.filter((item) => item.title === title)) {
      try {
        return await onlineArtifact(item.id, digest, title);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "artifact_version_mismatch") throw error;
      }
    }
    return null;
  }
  async function uploadArtifact(
    manifestHash: string,
    title: string,
    orgId: string,
    confirm: boolean,
  ) {
    if (
      !confirm ||
      !options.readArtifact ||
      !/^[a-f0-9]{64}$/.test(manifestHash) ||
      title.length > 200
    )
      throw new Error("upload_confirmation_required");
    const manifestBytes = await options.readArtifact("manifest", manifestHash);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== manifestHash)
      throw new Error("artifact_corrupt");
    const manifest: ArtifactManifest = parse(
      ArtifactManifestSchema,
      JSON.parse(manifestBytes.toString("utf8")),
    );
    validateManifest(manifest);
    if (possibleSecret("", title) || possibleSecret("", JSON.stringify(manifest)))
      throw new Error("possible_secret");
    const blobs = new Map<string, Buffer>();
    // Finish local validation of every file before sending any artifact metadata or bytes.
    for (const file of manifest.files) {
      const bytes = blobs.get(file.hash) ?? (await options.readArtifact("blob", file.hash));
      if (
        bytes.length !== file.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== file.hash
      )
        throw new Error("artifact_corrupt");
      if (possibleSecret(file.path, bytes.toString("utf8"))) throw new Error("possible_secret");
      blobs.set(file.hash, bytes);
    }
    const reservation = (await request(
      "/artifacts",
      "POST",
      JSON.stringify({
        confirm: true,
        orgId,
        title,
        manifest,
        idempotencyKey: createHash("sha256").update(`${manifestHash}\0${title}`).digest("hex"),
      }),
    )) as { id: string; state: string; uploaded: string[] };
    if (!/^[a-f0-9-]{36}$/.test(reservation.id)) throw new Error("invalid_upload_response");
    if (reservation.state !== "ready") {
      for (const [digest, bytes] of blobs) {
        if (!reservation.uploaded.includes(digest))
          await request(`/artifacts/${reservation.id}/blobs/${digest}`, "PUT", bytes);
      }
      await request(`/artifacts/${reservation.id}/commit`, "POST");
    }
    return onlineArtifact(
      reservation.id,
      createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      title,
    );
  }
  async function status() {
    if (!origin) return { configured: false, signedIn: false };
    if (!(await load())) return { configured: true, signedIn: false };
    return {
      configured: true,
      managementUrl: `${origin}/account`,
      signedIn: true,
      account: await request("/me"),
    };
  }
  async function signIn() {
    if (pending) throw new Error("sign_in_in_progress");
    // Force configuration validation before starting a listener or touching a browser.
    endpoint("/native/start");
    const verifier = randomBytes(32).toString("base64url"),
      state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let complete!: (code: string) => void, fail!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    // Handle cancellation while native/start or the browser opener is pending.
    void code.catch(() => {});
    const server = createServer((request, response) => {
      const expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(request.url ?? "/", `http://${expectedHost}`);
      const received = url.searchParams.get("state") ?? "";
      const valid =
        request.method === "GET" &&
        !request.headers.origin &&
        request.headers.host === expectedHost &&
        url.pathname === "/account/callback" &&
        received.length === state.length &&
        timingSafeEqual(Buffer.from(received), Buffer.from(state)) &&
        /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code") ?? "");
      response.writeHead(valid ? 200 : 400, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'",
      });
      response.end(valid ? "You can return to Zoltbot." : "Invalid sign-in response.");
      if (valid) complete(url.searchParams.get("code") as string);
    });
    pending = { server, cancel: () => fail(new Error("sign_in_cancelled")) };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      timer = setTimeout(() => fail(new Error("sign_in_timed_out")), options.timeoutMs ?? 600000);
      const start = await send(endpoint("/native/start"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challenge,
          state,
          redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/account/callback`,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!start.ok) throw new Error("account_service_unavailable");
      const target = (await start.json()) as { url: string };
      const url = new URL(target.url);
      if (url.origin !== origin || url.pathname !== "/api/account/auth/google/start")
        throw new Error("invalid_sign_in_url");
      await options.openBrowser(url.href);
      const result = await send(endpoint("/native/redeem"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: await code,
          verifier,
          deviceName: options.deviceName.slice(0, 100),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!result.ok) throw new Error("sign_in_failed");
      await save(credentials(await result.json()));
      return status();
    } finally {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      pending = undefined;
    }
  }
  return {
    status: () => serialized(status),
    signIn: () => serialized(signIn),
    cancel: () => pending?.cancel(),
    signOut: () =>
      serialized(async () => {
        try {
          await request("/logout", "POST");
        } finally {
          await clear();
        }
      }),
    revoke: (id: string) =>
      serialized(async () => {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("invalid_session_id");
        await request(`/sessions/${id}`, "DELETE");
        if (id === tokens?.sessionId) await clear();
        return status();
      }),
    revokeAll: () =>
      serialized(async () => {
        await request("/sessions/revoke-all", "POST");
        await clear();
        return status();
      }),
    export: () => serialized(() => request("/export")),
    uploadArtifact: (manifestHash: string, title: string, orgId: string, confirm: boolean) =>
      serialized(() => uploadArtifact(manifestHash, title, orgId, confirm)),
    findArtifact: (manifestHash: string, title: string) =>
      serialized(() => findArtifact(manifestHash, title)),
    setArtifactVisibility: (input: {
      id: string;
      hash: string;
      title: string;
      visibility: "private" | "public";
      confirm: true;
    }) =>
      serialized(async () => {
        if (input.confirm !== true || !["private", "public"].includes(input.visibility))
          throw new Error("publication_confirmation_required");
        const { digest } = await localManifest(input.hash);
        await onlineArtifact(input.id, digest, input.title);
        await request(
          `/artifacts/${input.id}/visibility`,
          "POST",
          JSON.stringify({
            visibility: input.visibility,
            confirm: true,
            manifestHash: digest,
          }),
        );
        return onlineArtifact(input.id, digest, input.title);
      }),
    copyArtifactLink: (id: string) =>
      serialized(async () => {
        const artifact = await onlineArtifact(id);
        if (!options.writeClipboard) throw new Error("clipboard_unavailable");
        options.writeClipboard(artifact.url);
        return { url: artifact.url };
      }),
    close: () => pending?.cancel(),
  };
}
