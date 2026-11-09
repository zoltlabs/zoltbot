import type { DeviceRecord, OfferRecord, PushPlatform, Registry } from "./registry.js";

// Firestore through its REST API, so the relay needs no gRPC client. On Cloud Run the access
// token comes from the metadata server. Layout:
//   macs/{macId}/devices/{deviceId}: publicKey, status, pushToken, platform, updatedAt
//   offers/{offerId}: macId, expiresAt (a TTL policy on expiresAt deletes old offers)

export interface FirestoreOptions {
  project: string;
  database?: string;
  /** host:port of the Firestore emulator. Skips auth. */
  emulatorHost?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Value = { stringValue: string } | { timestampValue: string };
type Fields = Record<string, Value>;
interface Document {
  fields?: Fields;
}

const metadata = "http://metadata.google.internal/computeMetadata/v1";

/** Reads the project id from the Cloud Run metadata server. */
export async function metadataProject(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`${metadata}/project/project-id`, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) throw new Error(`metadata project ${response.status}`);
  return (await response.text()).trim();
}

export class FirestoreRegistry implements Registry {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private token?: { value: string; expiresAt: number };

  constructor(private readonly options: FirestoreOptions) {
    const database = options.database ?? "(default)";
    const origin = options.emulatorHost
      ? `http://${options.emulatorHost}`
      : "https://firestore.googleapis.com";
    this.base = `${origin}/v1/projects/${options.project}/databases/${database}/documents`;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async auth(): Promise<string> {
    if (this.options.emulatorHost) return "Bearer owner";
    if (!this.token || this.token.expiresAt - 60_000 < this.now()) {
      const response = await this.fetch(`${metadata}/instance/service-accounts/default/token`, {
        headers: { "Metadata-Flavor": "Google" },
      });
      if (!response.ok) throw new Error(`metadata token ${response.status}`);
      const body = (await response.json()) as { access_token: string; expires_in: number };
      this.token = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    }
    return `Bearer ${this.token.value}`;
  }

  private async request(method: string, path: string, body?: unknown) {
    const response = await this.fetch(`${this.base}/${path}`, {
      method,
      headers: { authorization: await this.auth(), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`firestore ${method} ${response.status}`);
    return (await response.json()) as Document;
  }

  /** Writes `fields`; masked names missing from `fields` are deleted. Creates the document. */
  private patch(path: string, fields: Fields, mask: string[]) {
    const query = mask.map((name) => `updateMask.fieldPaths=${name}`).join("&");
    return this.request("PATCH", `${path}?${query}`, { fields });
  }

  private stamp(): Value {
    return { timestampValue: new Date(this.now()).toISOString() };
  }

  private devicePath(macId: string, deviceId: string) {
    return `macs/${macId}/devices/${deviceId}`;
  }

  async getDevice(macId: string, deviceId: string): Promise<DeviceRecord | undefined> {
    const doc = await this.request("GET", this.devicePath(macId, deviceId));
    if (!doc?.fields) return undefined;
    const record: DeviceRecord = {
      macId,
      deviceId,
      status: text(doc.fields.status) === "allowed" ? "allowed" : "revoked",
      updatedAt: text(doc.fields.updatedAt) ?? "",
    };
    const publicKey = text(doc.fields.publicKey);
    const pushToken = text(doc.fields.pushToken);
    const platform = text(doc.fields.platform);
    if (publicKey) record.publicKey = publicKey;
    if (pushToken && (platform === "apns" || platform === "apns-sandbox")) {
      record.pushToken = pushToken;
      record.platform = platform;
    }
    return record;
  }

  async allowDevice(macId: string, deviceId: string, publicKey?: string) {
    const fields: Fields = { status: { stringValue: "allowed" }, updatedAt: this.stamp() };
    const mask = ["status", "updatedAt"];
    if (publicKey) {
      fields.publicKey = { stringValue: publicKey };
      mask.push("publicKey");
    }
    await this.patch(this.devicePath(macId, deviceId), fields, mask);
  }

  async revokeDevice(macId: string, deviceId: string) {
    await this.patch(
      this.devicePath(macId, deviceId),
      { status: { stringValue: "revoked" }, updatedAt: this.stamp() },
      ["status", "updatedAt", "pushToken", "platform"],
    );
  }

  async setPushToken(macId: string, deviceId: string, platform: PushPlatform, token: string) {
    const current = await this.getDevice(macId, deviceId);
    if (current?.status !== "allowed") return false;
    await this.patch(
      this.devicePath(macId, deviceId),
      {
        pushToken: { stringValue: token },
        platform: { stringValue: platform },
        updatedAt: this.stamp(),
      },
      ["pushToken", "platform", "updatedAt"],
    );
    return true;
  }

  async clearPushToken(macId: string, deviceId: string) {
    const current = await this.getDevice(macId, deviceId);
    if (!current) return;
    await this.patch(this.devicePath(macId, deviceId), { updatedAt: this.stamp() }, [
      "pushToken",
      "platform",
      "updatedAt",
    ]);
  }

  async putOffer(offer: OfferRecord) {
    await this.patch(
      `offers/${offer.offerId}`,
      {
        macId: { stringValue: offer.macId },
        expiresAt: { timestampValue: new Date(offer.expiresAt).toISOString() },
      },
      ["macId", "expiresAt"],
    );
  }

  async getOffer(offerId: string): Promise<OfferRecord | undefined> {
    const doc = await this.request("GET", `offers/${offerId}`);
    const macId = text(doc?.fields?.macId);
    const expiresAt = Date.parse(text(doc?.fields?.expiresAt) ?? "");
    if (!macId || Number.isNaN(expiresAt)) return undefined;
    return { offerId, macId, expiresAt };
  }
}

function text(value: Value | undefined) {
  if (!value) return undefined;
  return "stringValue" in value ? value.stringValue : value.timestampValue;
}
