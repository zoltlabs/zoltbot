import { mkdir, writeFile } from "node:fs/promises";
import {
  agentEventSchemas,
  entitySchemas,
  eventCatalog,
  methodCatalog,
  protocolVersion,
} from "./src/index.js";

const directory = new URL("./schema/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const [name, body] of Object.entries({
  entities: entitySchemas,
  methods: methodCatalog,
  events: eventCatalog,
  adapterEvents: agentEventSchemas,
})) {
  await writeFile(
    new URL(`${name}.json`, directory),
    `${JSON.stringify({ protocolVersion, schemas: body })}\n`,
  );
}
