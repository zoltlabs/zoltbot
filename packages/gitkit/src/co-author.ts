// A4: commits Zoltbot makes for an agent carry a Co-Authored-By trailer naming the agent. The
// address is on a reserved domain (RFC 2606 `.invalid`), so it never maps to a real person.

export const CO_AUTHOR_DOMAIN = "agents.zoltbot.invalid";

/** A lowercase, dash-separated slug of an agent's name; "agent" when nothing is left. */
export function agentSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "agent";
}

/** The trailer for an agent: `Co-Authored-By: {name} <{slug}@{domain}>`. */
export function coAuthorTrailer(agentName: string, domain = CO_AUTHOR_DOMAIN): string {
  const name =
    agentName
      .replace(/[<>\r\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60)
      .trim() || "Agent";
  return `Co-Authored-By: ${name} <${agentSlug(name)}@${domain}>`;
}

/** A project's own address domain, when it set a plain host name. */
export const coAuthorDomain = (value: unknown): string =>
  typeof value === "string" && /^(?=.{1,100}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value)
    ? value.toLowerCase()
    : CO_AUTHOR_DOMAIN;

/**
 * A project's commit message for an agent. On unless the project turned `coAuthorLine` off; with
 * it off, the message is left as the owner wrote it.
 */
export function agentCommitMessage(
  message: string,
  agentName: string | undefined,
  project: { coAuthorLine?: unknown; coAuthorDomain?: unknown } | undefined,
): string {
  if (!agentName?.trim() || project?.coAuthorLine === false) return message;
  return withCoAuthor(message, agentName, coAuthorDomain(project?.coAuthorDomain));
}

/**
 * The message with the trailer added once at the end, in its own trailer block. A message that
 * already names the same address (in any letter case) is returned unchanged.
 */
export function withCoAuthor(message: string, agentName: string, domain?: string): string {
  const trailer = coAuthorTrailer(agentName, domain);
  const address = trailer.slice(trailer.indexOf("<")).toLowerCase();
  const body = message.replace(/\s+$/, "");
  const lines = body.split("\n");
  if (
    lines.some(
      (line) => /^co-authored-by:/i.test(line.trim()) && line.toLowerCase().includes(address),
    )
  )
    return body;
  // Join an existing trailer block; otherwise start one after a blank line.
  return trailerBlock(lines) ? `${body}\n${trailer}` : `${body}\n\n${trailer}`;
}

/** True when the last paragraph is made only of `Token: value` lines and isn't the subject. */
function trailerBlock(lines: string[]): boolean {
  let start = lines.length;
  while (start > 0 && lines[start - 1]?.trim() !== "") start -= 1;
  if (start === 0 || start === lines.length) return false;
  return lines.slice(start).every((line) => /^[A-Za-z][A-Za-z0-9-]*: /.test(line));
}
