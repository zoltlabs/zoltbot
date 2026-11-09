/** Conservative shell subset: ambiguity always returns no reusable match. */
export function tokenizeCommand(command: string): string[] | undefined {
  if (
    !command ||
    command.length > 16000 ||
    [...command].some(
      (char) => (char.charCodeAt(0) < 32 && char !== "\t") || char.charCodeAt(0) === 127,
    ) ||
    /[|&;<>$`#(){}*!?[\]~]/.test(command)
  )
    return undefined;
  const argv: string[] = [];
  let token = "",
    quote = "",
    started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index] as string;
    if (char === "\\" && quote !== "'") {
      const next = command[++index];
      if (next === undefined || (quote === '"' && next !== "\\" && next !== '"')) return undefined;
      token += next;
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else {
      token += char;
      started = true;
    }
    if (argv.length > 256) return undefined;
  }
  if (quote) return undefined;
  if (started) argv.push(token);
  if (!argv.length || !argv[0] || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) return undefined;
  return argv;
}
