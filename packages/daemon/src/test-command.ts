/** A coarse, non-sensitive category derived before command text is redacted. */
export function isTestCommand(input: unknown): boolean {
  let value =
    typeof input === "string" || Array.isArray(input)
      ? input
      : input && typeof input === "object"
        ? (input as { command?: unknown }).command
        : undefined;
  if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
    const [binary, flags] = value as string[];
    value =
      /(?:^|\/)(?:ba|z|k)?sh$/.test(binary ?? "") && /^-[a-z]*c[a-z]*$/.test(flags ?? "")
        ? value[2]
        : value.join(" ");
  }
  if (typeof value !== "string") return false;
  const shell = value.match(/^(?:\/[^\s]+\/)?(?:ba|z|k)?sh\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1$/);
  const command = shell?.[2] ?? value;
  if (/\|\||[|;\n`]/.test(command)) return false;
  const finalCommand =
    command
      .split(/\s*&&\s*/)
      .at(-1)
      ?.trim() ?? "";
  // Require a runner invocation, not just a filename or `echo test` in an arbitrary command.
  return /^\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+|env)\s+)*(?:(?:\/[^\s]+\/)?(?:node|bun)\s+--test\b|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\b|:)|(?:npx\s+)?(?:vitest|jest|pytest|rspec|mocha|ctest)\b|python(?:3)?\s+-m\s+(?:pytest|unittest)\b|(?:cargo|go|dotnet|mix)\s+test\b)/i.test(
    finalCommand,
  );
}
