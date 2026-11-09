import { publishHash } from "../../../gitkit/src/publish.js";

/** Short lived daemon-owned proposals. Fingerprints cannot authorize caller-supplied mutation data. */
export class ShippingProposals {
  private readonly proposals = new Map<
    string,
    { taskId: string; kind: string; value: Record<string, unknown>; expires: number }
  >();
  put(taskId: string, kind: string, value: Record<string, unknown>) {
    const expires = Date.now() + 5 * 60_000;
    const fingerprint = publishHash({ taskId, kind, value, expires });
    for (const [key, row] of this.proposals)
      if (row.expires < Date.now()) this.proposals.delete(key);
    if (this.proposals.size > 100) throw new Error("shipping_preview_limit");
    this.proposals.set(fingerprint, { taskId, kind, value, expires });
    return { ...value, fingerprint };
  }
  get(taskId: string, kind: string, fingerprint: string) {
    const row = this.proposals.get(fingerprint);
    if (!row || row.taskId !== taskId || row.kind !== kind || row.expires < Date.now())
      throw new Error("shipping_preview_expired");
    return row.value;
  }
}
