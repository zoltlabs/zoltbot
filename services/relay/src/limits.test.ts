// P8: a phone watching an agent's browser stays well inside the Mac's relay allowance.
import { maxFrameBytes, phoneScreen } from "@zoltbot/link";
import { describe, expect, it } from "vitest";
import { Bucket, defaultLimits } from "./limits.js";

describe("phone screen frames", () => {
  it("fit one relay frame each", () => {
    // Base64 inside JSON, sealed and wrapped: well under the frame cap.
    expect(phoneScreen.maxFrameBytes * 2).toBeLessThan(maxFrameBytes);
  });

  it("let four phones watch at full pace without the Mac being limited", () => {
    let clock = 0;
    const now = () => clock;
    const frames = new Bucket(defaultLimits.frames.mac, now);
    const bytes = new Bucket(defaultLimits.bytes.mac, now);
    const phones = 4;
    // Each phone's worst case: largest frames at the fastest pace until its minute's budget
    // runs out, plus ordinary chat traffic beside it.
    const used = Array(phones).fill(0);
    let refused = 0;
    for (let tick = 0; tick < 120_000; tick += phoneScreen.minIntervalMs) {
      clock = tick;
      for (let phone = 0; phone < phones; phone++) {
        if (tick % 60_000 < phoneScreen.minIntervalMs) used[phone] = 0;
        if (used[phone] + phoneScreen.maxFrameBytes > phoneScreen.bytesPerMinute) continue;
        used[phone] += phoneScreen.maxFrameBytes;
        // Sealing carries the text as base64, a third larger.
        const sealed = Math.ceil((phoneScreen.maxFrameBytes * 4) / 3) + 1024;
        if (!frames.take() || !bytes.take(sealed)) refused++;
      }
      if (!frames.take(5) || !bytes.take(5 * 4096)) refused++;
    }
    expect(refused).toBe(0);
  });
});
