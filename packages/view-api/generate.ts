import { mkdir, writeFile } from "node:fs/promises";
import {
  callSchemas,
  HostMessageSchema,
  topicSchemas,
  ViewManifestSchema,
  ViewMessageSchema,
} from "./src/index.js";

const directory = new URL("./schema/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, schemas] of Object.entries({
  manifest: ViewManifestSchema,
  topics: topicSchemas,
  bridge: { view: ViewMessageSchema, host: HostMessageSchema },
  calls: callSchemas,
}))
  await writeFile(new URL(`${name}.json`, directory), `${JSON.stringify({ api: 1, schemas })}\n`);
