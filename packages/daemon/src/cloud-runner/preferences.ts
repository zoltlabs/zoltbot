import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import { parse } from "@zoltbot/protocol";

const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$" });
export const macRunnerPreferencesSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: Type.String({
      pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    }),
    orgId: id,
    cloudEnabled: Type.Optional(Type.Boolean()),
    runTasksOnMac: Type.Boolean(),
    macExecution: Type.Union([
      Type.Literal("off"),
      Type.Literal("ask"),
      Type.Literal("allow_listed"),
    ]),
    folders: Type.Record(id, Type.String({ minLength: 1, maxLength: 4096 })),
    keys: Type.Optional(
      Type.Object(
        {
          github: Type.Optional(Type.String()),
          anthropic: Type.Optional(Type.String()),
          openai: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type MacRunnerPreferences = Static<typeof macRunnerPreferencesSchema>;

export async function readMacRunnerPreferences(file: string) {
  try {
    // O_NOFOLLOW prevents replacing an owner's settings file with a symlink.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 65_536 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error();
      const bytes = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(bytes) > 65_536) throw new Error();
      const settings = parse(macRunnerPreferencesSchema, JSON.parse(bytes));
      if (
        Object.values(settings.folders).some(
          (folder) => !path.isAbsolute(folder) || folder.includes("\0"),
        )
      )
        throw new Error();
      return { stamp: `${info.ino}:${info.mtimeMs}:${bytes}`, settings };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("mac_runner_preferences_invalid");
  }
}
