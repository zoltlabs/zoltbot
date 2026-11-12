import { mkdir, writeFile } from "node:fs/promises";
import { RunnerMessageSchema, runnerMethods, runnerProtocolVersion } from "./src/index.js";

const directory = new URL("./schema/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("messages.json", directory),
  `${JSON.stringify({ runnerProtocolVersion, message: RunnerMessageSchema, methods: runnerMethods })}\n`,
);
