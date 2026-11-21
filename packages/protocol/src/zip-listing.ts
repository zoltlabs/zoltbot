// C18: lists a ZIP's files from its central directory, the index at the end of the file. Nothing
// is unpacked or decompressed; the caller supplies a reader, so a file is never read whole.

export interface ZipEntry {
  name: string;
  /** Size once unpacked, in bytes. */
  size: number;
}

export interface ZipListing {
  /** The first `ZIP_LISTED_ENTRIES` files, in archive order. Folders are left out. */
  entries: ZipEntry[];
  /** Files in the whole archive. */
  files: number;
  /** Their total size once unpacked. */
  unpacked: number;
}

export const ZIP_LISTED_ENTRIES = 500;
/** A central directory bigger than this is refused rather than read. */
const MAX_DIRECTORY = 16 * 1024 * 1024;
/** Longer names are cut, so one odd entry can't bloat the listing. */
const MAX_NAME = 512;
const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const ENTRY = 0x02014b50;

export type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(data: DataView, at: number): number {
  const value = data.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("zip_unreadable");
  return Number(value);
}

/** Reads the listing, or throws "zip_unreadable" for anything that isn't a sound ZIP. */
export async function readZipListing(read: ReadRange, size: number): Promise<ZipListing> {
  if (size < 22) throw new Error("zip_unreadable");
  // The end record sits in the last 22 bytes plus a comment of up to 65,535.
  const tailLength = Math.min(size, 22 + 65_535);
  const tail = await read(size - tailLength, tailLength);
  const tailView = view(tail);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (tailView.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("zip_unreadable");
  let count = tailView.getUint16(end + 10, true);
  let directorySize = tailView.getUint32(end + 12, true);
  let directoryOffset = tailView.getUint32(end + 16, true);
  // ZIP64: a locator just before the end record points at the larger end record. Exactly
  // 65,535 files fits the plain record too, so the locator decides, not the marker values.
  const locatorAt = end - 20;
  const zip64 = locatorAt >= 0 && tailView.getUint32(locatorAt, true) === LOCATOR64;
  if (!zip64 && (directorySize === 0xffffffff || directoryOffset === 0xffffffff))
    throw new Error("zip_unreadable");
  if (zip64) {
    const recordAt = u64(tailView, locatorAt + 8);
    if (recordAt + 56 > size) throw new Error("zip_unreadable");
    const record = view(await read(recordAt, 56));
    if (record.getUint32(0, true) !== EOCD64) throw new Error("zip_unreadable");
    count = u64(record, 32);
    directorySize = u64(record, 40);
    directoryOffset = u64(record, 48);
  }
  if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > size)
    throw new Error("zip_unreadable");
  const directory = await read(directoryOffset, directorySize);
  const data = view(directory);
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let files = 0;
  let unpacked = 0;
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.length || data.getUint32(at, true) !== ENTRY)
      throw new Error("zip_unreadable");
    let entrySize = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new Error("zip_unreadable");
    const full = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
    const name = full.length > MAX_NAME ? `${full.slice(0, MAX_NAME - 1)}…` : full;
    if (entrySize === 0xffffffff) {
      // The real size is in the ZIP64 extra field, first when present.
      let extra = at + 46 + nameLength;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const id = data.getUint16(extra, true);
        const length = data.getUint16(extra + 2, true);
        if (id === 0x0001 && length >= 8) {
          entrySize = u64(data, extra + 4);
          break;
        }
        extra += 4 + length;
      }
    }
    at = next;
    if (full.endsWith("/")) continue;
    files++;
    unpacked += entrySize;
    if (entries.length < ZIP_LISTED_ENTRIES) entries.push({ name, size: entrySize });
  }
  return { entries, files, unpacked };
}
