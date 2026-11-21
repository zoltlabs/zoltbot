#!/usr/bin/env node
// R5: the zolt command's entry point.
import { run } from "./cli.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
