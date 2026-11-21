// V4: does a message the owner is about to send look like it holds a password or key? Shared by
// the desktop composer and the phone, so both agree. A miss sends the text as
// before; a false alarm costs the owner one click on "Send anyway", so the patterns favour
// well-known key shapes over guessing.

export interface SecretMatch {
  /** Where the secret is in the text, so saving can replace just that part. */
  start: number;
  end: number;
  kind: "private_key" | "api_key" | "token" | "password";
}

const KEY_PATTERNS: [RegExp, SecretMatch["kind"]][] = [
  [
    /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
    "private_key",
  ],
  [/\b(?:sk-proj-|sk-ant-[a-z0-9]*-?)[A-Za-z0-9_-]{16,}/, "api_key"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, "api_key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "token"],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}\b/, "token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "api_key"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, "token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "api_key"],
  [/\b(?:rk|sk|pk)_live_[A-Za-z0-9]{16,}\b/, "api_key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "token"],
  [/\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/, "token"],
];

/** `password: hunter2…`, `api_key=…`: the value after a label that names a secret. */
const LABELLED =
  /\b(?:password|passwd|pwd|passphrase|api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*(?:is\s+)?[:=]\s*["']?([^\s"']{8,})/i;

/** A single pasted word that mixes letters, digits and symbols like a generated password. */
function generatedWord(text: string): SecretMatch | undefined {
  const word = text.trim();
  if (word.length < 12 || word.length > 200 || /\s/.test(word)) return undefined;
  // Things that look random but aren't secret: hashes, ids, links, paths, emails.
  if (/^[0-9a-f]{7,64}$/i.test(word)) return undefined;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(word))
    return undefined;
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(word) ||
    /[/\\@]/.test(word) ||
    /^[\w.-]+\.[a-z]{2,}$/i.test(word)
  )
    return undefined;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(word)).length;
  // Words like "TypeScript2026" mix cases and digits too; a symbol or a long run tells them apart.
  if (classes < 3 || (!/[^A-Za-z0-9]/.test(word) && word.length < 20)) return undefined;
  const start = text.indexOf(word);
  return { start, end: start + word.length, kind: "password" };
}

export function findSecret(text: string): SecretMatch | undefined {
  if (!text || text.length > 20_000) return undefined;
  for (const [pattern, kind] of KEY_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    // A Bearer header keeps its label; only the token is the secret.
    const value = match[1] ?? match[0];
    const start = match.index + match[0].indexOf(value);
    return { start, end: start + value.length, kind };
  }
  const labelled = LABELLED.exec(text);
  if (labelled?.[1]) {
    const start = labelled.index + labelled[0].lastIndexOf(labelled[1]);
    return { start, end: start + labelled[1].length, kind: "password" };
  }
  return generatedWord(text);
}

/** What the agent sees in place of a saved secret. */
export function vaultReference(label: string): string {
  return `[vault: ${label
    .replace(/[[\]\p{Cc}]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .slice(0, 80)}]`;
}
