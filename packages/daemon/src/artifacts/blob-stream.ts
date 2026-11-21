// C18: an artifact file read as a stream, so a 100 MB file never sits in memory. It is checked
// the way blobBytes checks it: hash-named, a plain file with one link, owned by this user. The
// hash is checked as the bytes go out; a mismatch errors the stream at its end, so a reader that
// waits for the whole file never sees a changed one.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pipeline, Transform } from "node:stream";
import { artifactLimits, artifactOwnerAllowed, checkedAncestors } from "./intake.js";

export async function blobStream(
  directory: string,
  hash: string,
): Promise<{ size: number; stream: Transform }> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("invalid_artifact_hash");
  const blobs = path.join(directory, "blobs");
  await checkedAncestors(blobs);
  const file = await open(path.join(blobs, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
  let size: number;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !artifactOwnerAllowed(stat.uid) ||
      stat.size > artifactLimits.file
    )
      throw Error("artifact_file_denied");
    size = stat.size;
  } catch (error) {
    await file.close();
    throw error;
  }
  const hashing = createHash("sha256");
  let count = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      count += chunk.length;
      if (count > size) return done(Error("artifact_blob_corrupt"));
      hashing.update(chunk);
      done(null, chunk);
    },
    flush(done) {
      done(
        count === size && hashing.digest("hex") === hash ? null : Error("artifact_blob_corrupt"),
      );
    },
  });
  const source = file.createReadStream({ end: Math.max(size - 1, 0) });
  if (size === 0) {
    source.destroy();
    check.end();
    return { size, stream: check };
  }
  // pipeline closes the file when the reader goes away or either side fails.
  pipeline(source, check, () => undefined);
  return { size, stream: check };
}
