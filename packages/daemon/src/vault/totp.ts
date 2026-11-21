// V6: two-step codes from a saved setup key (RFC 6238 over RFC 4226). Runs in the daemon only;
// the setup key never leaves it, and the agent receives nothing but the fact that a code was typed.
import { createHmac } from "node:crypto";
import type { TotpSetup } from "@zoltbot/protocol";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, as setup keys are written; spaces, dashes and padding are ignored. */
export function base32Decode(input: string): Buffer {
  const text = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid_setup_key");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP for a counter, with the HMAC the setup names. */
export function hotp(
  key: Buffer,
  counter: number,
  digits: number,
  algorithm: TotpSetup["algorithm"],
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code for `at` (milliseconds), and how many seconds it stays valid. */
export function totp(
  setup: Pick<TotpSetup, "secret" | "algorithm"> & { digits: number; period: number },
  at = Date.now(),
) {
  // Values come back from the keychain; a damaged one gives no code rather than a wrong one.
  if (![6, 7, 8].includes(setup.digits) || !(setup.period >= 1 && setup.period <= 300))
    throw new Error("vault_value_invalid");
  const step = Math.floor(at / 1000 / setup.period);
  return {
    code: hotp(base32Decode(setup.secret), step, setup.digits, setup.algorithm),
    secondsLeft: setup.period - (Math.floor(at / 1000) % setup.period),
  };
}
