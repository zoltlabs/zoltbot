import type { UserInput } from "@zoltbot/protocol";

/** A Cell path is not permission to open a file on the receiving Mac or worker. */
export function assertPortableCloudInput(input: UserInput): void {
  if (input.some((part) => part.type === "file" || (part.type === "image" && part.path)))
    throw new Error("runner_input_requires_upload");
}
