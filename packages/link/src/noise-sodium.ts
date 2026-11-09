// The sodium API used by noise-handshake, backed by the existing Noble primitives on Hermes.
// Metro selects this adapter; Node uses sodium-native. No handshake or key schedule lives here.
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { randomBytes } from "@noble/hashes/utils";

export const crypto_kx_SEEDBYTES = 32;
export const crypto_scalarmult_BYTES = 32;
export const crypto_scalarmult_SCALARBYTES = 32;
export const crypto_aead_chacha20poly1305_ietf_NPUBBYTES = 12;
export const crypto_aead_chacha20poly1305_ietf_ABYTES = 16;

export function sodium_memzero(bytes: Uint8Array | null) {
  bytes?.fill(0);
}
export function crypto_generichash(out: Uint8Array, input: Uint8Array) {
  out.set(blake2b(input, { dkLen: out.length }));
}
export function crypto_generichash_batch(out: Uint8Array, inputs: Uint8Array[]) {
  const hash = blake2b.create({ dkLen: out.length });
  for (const input of inputs) hash.update(input);
  out.set(hash.digest());
}
export function crypto_scalarmult_base(out: Uint8Array, secret: Uint8Array) {
  out.set(x25519.getPublicKey(secret));
}
export function crypto_scalarmult(out: Uint8Array, secret: Uint8Array, publicKey: Uint8Array) {
  out.set(x25519.getSharedSecret(secret, publicKey));
}
export function crypto_kx_keypair(publicKey: Uint8Array, secretKey: Uint8Array) {
  secretKey.set(randomBytes(32));
  crypto_scalarmult_base(publicKey, secretKey);
}
export function crypto_kx_seed_keypair(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
  seed: Uint8Array,
) {
  if (seed.length !== 32) throw new Error("bad_seed");
  secretKey.set(blake2b(seed, { dkLen: 32 }));
  crypto_scalarmult_base(publicKey, secretKey);
}
export function crypto_aead_chacha20poly1305_ietf_encrypt(
  out: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
  _secretNonce: null,
  nonce: Uint8Array,
  key: Uint8Array,
) {
  out.set(chacha20poly1305(key, nonce, aad).encrypt(plaintext));
}
export function crypto_aead_chacha20poly1305_ietf_decrypt(
  out: Uint8Array,
  _secretNonce: null,
  ciphertext: Uint8Array,
  aad: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array,
) {
  out.set(chacha20poly1305(key, nonce, aad).decrypt(ciphertext));
}
