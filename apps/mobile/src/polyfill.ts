import { getRandomValues } from "expo-crypto";

// @noble (via @zoltbot/link) needs Web Crypto's getRandomValues; Hermes may not provide it.
const scope = globalThis as { crypto?: { getRandomValues?: unknown } };
scope.crypto ??= {};
scope.crypto.getRandomValues ??= getRandomValues;
