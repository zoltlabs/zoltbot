/** This is an argv tokenizer, not a shell interpreter. */
export function parseCommand(text: string): string[] {
  if (!text.trim() || text.length > 8192 || /[\n\r\0;$`|&<>]/.test(text))
    throw new Error("invalid_command");
  const args: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"') {
        const next = text[++index];
        if (next === undefined) throw new Error("invalid_command");
        word += next;
      } else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(word);
        word = "";
        started = false;
      }
    } else if (char === "\\") {
      const next = text[++index];
      if (next === undefined) throw new Error("invalid_command");
      word += next;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("invalid_command");
  if (started) args.push(word);
  if (
    !args[0] ||
    args.length > 128 ||
    args.some(
      (arg) =>
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) ||
        /(?:^--?[^=]*(?:api[-_]?key|token|password|secret|authorization|credential)[^=]*)(?:=|$)/i.test(
          arg,
        ),
    )
  )
    throw new Error("invalid_command");
  return args;
}
