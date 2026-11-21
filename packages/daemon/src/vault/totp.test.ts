import { expect, it } from "vitest";
import { base32Decode, hotp, totp } from "./totp.js";

// RFC 6238 Appendix B: the ASCII seeds "12345678901234567890" (SHA1), 32 bytes (SHA256) and
// 64 bytes (SHA512), eight digits, a 30-second step.
const SEEDS = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
} as const;
const base32 = (ascii: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of Buffer.from(ascii)) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
};
const VECTORS: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

it("matches the RFC 6238 test vectors for SHA1, SHA256 and SHA512", () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS)
    for (const [algorithm, expected] of [
      ["SHA1", sha1],
      ["SHA256", sha256],
      ["SHA512", sha512],
    ] as const)
      expect(
        totp({ secret: base32(SEEDS[algorithm]), digits: 8, period: 30, algorithm }, seconds * 1000)
          .code,
      ).toBe(expected);
});

it("matches the RFC 4226 HOTP vectors and reads setup keys with spaces", () => {
  const key = Buffer.from(SEEDS.SHA1);
  expect([0, 1, 2, 9].map((counter) => hotp(key, counter, 6, "SHA1"))).toEqual([
    "755224",
    "287082",
    "359152",
    "520489",
  ]);
  expect(base32Decode("gezd gnbv-gy3t qojq")).toEqual(Buffer.from("1234567890"));
  expect(() => base32Decode("not base32!")).toThrow("invalid_setup_key");
  expect(
    totp({ secret: base32(SEEDS.SHA1), digits: 6, period: 30, algorithm: "SHA1" }, 59_000),
  ).toEqual({ code: "287082", secondsLeft: 1 });
});
