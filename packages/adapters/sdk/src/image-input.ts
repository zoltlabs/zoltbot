import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { UserInput } from "@zoltbot/protocol";

export const IMAGE_INPUT_BYTES = 512 * 1024;
function imageMime(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  throw new Error("invalid_image_format");
}
async function selectedImage(file: string, remaining: number) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new Error("attachment_unavailable");
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("attachment_unavailable");
    if (stat.size > remaining) throw new Error("image_budget_exceeded");
    const bytes = Buffer.alloc(remaining + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > remaining) throw new Error("image_budget_exceeded");
    return bytes.subarray(0, offset);
  } catch (error) {
    if (
      error instanceof Error &&
      ["attachment_unavailable", "image_budget_exceeded"].includes(error.message)
    )
      throw error;
    throw new Error("attachment_unavailable");
  } finally {
    await handle.close().catch(() => {
      throw new Error("attachment_unavailable");
    });
  }
}
/** Local image bytes are ephemeral native input, never replacements for durable human intent. */
export async function materializeImages(input: UserInput): Promise<UserInput> {
  if (!input.some((part) => part.type === "image")) return input;
  let remaining = IMAGE_INPUT_BYTES;
  const result: UserInput = [];
  for (const part of input) {
    if (part.type !== "image") {
      result.push(part);
      continue;
    }
    let bytes: Buffer;
    if (part.path) bytes = await selectedImage(part.path, remaining);
    else if (part.base64) {
      if (part.base64.length > Math.ceil(remaining / 3) * 4)
        throw new Error("image_budget_exceeded");
      bytes = Buffer.from(part.base64, "base64");
      if (bytes.toString("base64") !== part.base64) throw new Error("invalid_image_format");
    } else throw new Error("attachment_unavailable");
    remaining -= bytes.length;
    if (remaining < 0) throw new Error("image_budget_exceeded");
    const mimeType = imageMime(bytes);
    if (part.mimeType && part.mimeType.toLowerCase() !== mimeType)
      throw new Error("invalid_image_format");
    result.push({ type: "image", mimeType, base64: bytes.toString("base64") });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 900 * 1024)
    throw new Error("native_input_too_large");
  return result;
}
