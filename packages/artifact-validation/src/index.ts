import path from "node:path";
import type { ArtifactManifest } from "@zoltbot/protocol";

export { verifiedType } from "./types.js";
export const artifactLimits = { file: 25 * 1024 * 1024, version: 100 * 1024 * 1024, files: 500 };
export function artifactPath(value: string) {
  if (
    !value ||
    value.length > 512 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    [...value].some((c) => c.charCodeAt(0) < 32) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw Error("invalid_artifact_path");
  return value.normalize("NFC");
}
export function possibleSecret(name: string, text: string) {
  return (
    /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(pem|key|p12)$/i.test(name) ||
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----|Bearer\s+[^\s"']+|\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_+/-]{16,}/i.test(
      text,
    )
  );
}
export function validateManifest(manifest: ArtifactManifest) {
  const names = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (manifest.kit && file.path.startsWith("kit/")) throw Error("artifact_reserved_kit_path");
    const normalized = artifactPath(file.path);
    if (normalized !== file.path || names.has(normalized.toLowerCase()))
      throw Error("artifact_path_collision");
    names.add(normalized.toLowerCase());
    total += file.bytes;
  }
  if (total > artifactLimits.version) throw Error("artifact_limit_exceeded");
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  if (!files.has(manifest.entry)) throw Error("artifact_entry_missing");
  const ids = new Set<string>();
  for (const screen of manifest.screens) {
    if (ids.has(screen.id) || !files.has(screen.path)) throw Error("artifact_screen_invalid");
    ids.add(screen.id);
  }
}
