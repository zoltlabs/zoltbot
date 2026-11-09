// The device registry: which devices each Mac allowed, their keys and push tokens, and live
// pairing offers. It never holds messages. Firestore backs it in production (firestore.ts).

export type PushPlatform = "apns" | "apns-sandbox";

export interface DeviceRecord {
  macId: string;
  deviceId: string;
  /** Base64url Ed25519 public key, when the relay saw the device sign in. */
  publicKey?: string;
  status: "allowed" | "revoked";
  pushToken?: string;
  platform?: PushPlatform;
  updatedAt: string;
}

export interface OfferRecord {
  offerId: string;
  macId: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export interface Registry {
  getDevice(macId: string, deviceId: string): Promise<DeviceRecord | undefined>;
  /** Marks the device allowed, creating the record when needed. */
  allowDevice(macId: string, deviceId: string, publicKey?: string): Promise<void>;
  /** Marks the device revoked and drops its push token. */
  revokeDevice(macId: string, deviceId: string): Promise<void>;
  /** Stores a push token for an allowed device. Returns false when the device is not allowed. */
  setPushToken(
    macId: string,
    deviceId: string,
    platform: PushPlatform,
    token: string,
  ): Promise<boolean>;
  /** Drops a push token APNs rejected. */
  clearPushToken(macId: string, deviceId: string): Promise<void>;
  putOffer(offer: OfferRecord): Promise<void>;
  getOffer(offerId: string): Promise<OfferRecord | undefined>;
}

export class MemoryRegistry implements Registry {
  readonly devices = new Map<string, DeviceRecord>();
  readonly offers = new Map<string, OfferRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  private key(macId: string, deviceId: string) {
    return `${macId}/${deviceId}`;
  }
  private stamp() {
    return new Date(this.now()).toISOString();
  }

  async getDevice(macId: string, deviceId: string) {
    const record = this.devices.get(this.key(macId, deviceId));
    return record && { ...record };
  }

  async allowDevice(macId: string, deviceId: string, publicKey?: string) {
    const current = this.devices.get(this.key(macId, deviceId));
    const record: DeviceRecord = {
      ...current,
      macId,
      deviceId,
      status: "allowed",
      updatedAt: this.stamp(),
    };
    if (publicKey) record.publicKey = publicKey;
    this.devices.set(this.key(macId, deviceId), record);
  }

  async revokeDevice(macId: string, deviceId: string) {
    const current = this.devices.get(this.key(macId, deviceId));
    const record: DeviceRecord = { macId, deviceId, status: "revoked", updatedAt: this.stamp() };
    if (current?.publicKey) record.publicKey = current.publicKey;
    this.devices.set(this.key(macId, deviceId), record);
  }

  async setPushToken(macId: string, deviceId: string, platform: PushPlatform, token: string) {
    const current = this.devices.get(this.key(macId, deviceId));
    if (current?.status !== "allowed") return false;
    this.devices.set(this.key(macId, deviceId), {
      ...current,
      platform,
      pushToken: token,
      updatedAt: this.stamp(),
    });
    return true;
  }

  async clearPushToken(macId: string, deviceId: string) {
    const current = this.devices.get(this.key(macId, deviceId));
    if (!current) return;
    const { pushToken: _token, platform: _platform, ...rest } = current;
    this.devices.set(this.key(macId, deviceId), { ...rest, updatedAt: this.stamp() });
  }

  async putOffer(offer: OfferRecord) {
    this.offers.set(offer.offerId, { ...offer });
  }

  async getOffer(offerId: string) {
    const offer = this.offers.get(offerId);
    return offer && { ...offer };
  }
}
