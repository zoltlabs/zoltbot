import type { DocumentComment } from "../../shared/documents";

const clip = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/**
 * The task brief that asks an agent to revise a document from the person's comments. It names
 * the file by its absolute path, quotes each passage and asks for edits in place, so the changes
 * come back to the same file for review.
 */
export function commentsMessage(input: {
  path: string;
  absolutePath: string;
  comments: DocumentComment[];
  note: string;
}): string {
  const lines = [
    `Please revise \`${input.path}\` based on my comments below.`,
    "",
    `Edit the file in place at \`${input.absolutePath}\`. Change only what the comments ask for and keep everything else as it is. I'll review your changes word by word in Zoltbot, so don't rename or move the file.`,
    "",
  ];
  input.comments.forEach((comment, index) => {
    const quote = clip(comment.anchor.quote.replace(/\s+/g, " ").trim(), 240);
    lines.push(`${index + 1}. On “${quote}”:`);
    for (const line of comment.body.trim().split("\n")) lines.push(`   ${line}`);
  });
  const note = input.note.trim();
  if (note) lines.push("", note);
  return lines.join("\n");
}
