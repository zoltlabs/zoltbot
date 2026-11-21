import { describe, expect, it } from "vitest";
import { readZipListing, ZIP_LISTED_ENTRIES } from "./zip-listing.js";

/** A stored (uncompressed) ZIP; `big` names an entry whose size goes in a ZIP64 extra field. */
function zip(files: { name: string; data?: string; size?: number }[], comment = "") {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data ?? "");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const zip64 = file.size !== undefined;
    const extra = Buffer.alloc(zip64 ? 12 : 0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(file.size ?? 0), 4);
    }
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
    entry.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(extra.length, 30);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name, extra);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, directory, end, Buffer.from(comment)]);
}

function reader(bytes: Buffer) {
  const reads: number[] = [];
  return {
    reads,
    read: async (offset: number, length: number) => {
      reads.push(length);
      return bytes.subarray(offset, offset + length);
    },
  };
}

describe("readZipListing", () => {
  it("lists files and their unpacked sizes, leaving out folders", async () => {
    const bytes = zip(
      [{ name: "docs/" }, { name: "docs/a.txt", data: "hello" }, { name: "b.csv", data: "x,y" }],
      "made by a test",
    );
    const { read } = reader(bytes);
    expect(await readZipListing(read, bytes.length)).toEqual({
      entries: [
        { name: "docs/a.txt", size: 5 },
        { name: "b.csv", size: 3 },
      ],
      files: 2,
      unpacked: 8,
    });
  });

  it("reads ZIP64 sizes and lists only the first entries of a long archive", async () => {
    const many = Array.from({ length: ZIP_LISTED_ENTRIES + 20 }, (_, i) => ({ name: `f${i}` }));
    const bytes = zip([{ name: "huge.bin", size: 6_000_000_000 }, ...many]);
    const { read } = reader(bytes);
    const listing = await readZipListing(read, bytes.length);
    expect(listing.entries).toHaveLength(ZIP_LISTED_ENTRIES);
    expect(listing.entries[0]).toEqual({ name: "huge.bin", size: 6_000_000_000 });
    expect(listing.files).toBe(ZIP_LISTED_ENTRIES + 21);
    expect(listing.unpacked).toBe(6_000_000_000);
  });

  it("reads only the end of the file and the directory, never the contents", async () => {
    const bytes = Buffer.concat([zip([{ name: "big.bin", data: "z".repeat(200_000) }])]);
    const { read, reads } = reader(bytes);
    await readZipListing(read, bytes.length);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(70_000);
  });

  it("refuses files that aren't a sound ZIP", async () => {
    for (const bytes of [
      Buffer.from("not a zip at all, just some words here"),
      Buffer.alloc(10),
      zip([{ name: "a", data: "1" }]).subarray(5),
    ]) {
      const { read } = reader(bytes);
      await expect(readZipListing(read, bytes.length)).rejects.toThrow("zip_unreadable");
    }
  });
});

it("cuts very long names and reads exactly 65,535 files without ZIP64", async () => {
  const names = Array.from({ length: 0xffff }, (_, i) => (i === 0 ? "a".repeat(2000) : `f${i}`));
  const central: Buffer[] = [];
  for (const n of names) {
    const name = Buffer.from(n);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(1, 24);
    entry.writeUInt16LE(name.length, 28);
    central.push(entry, name);
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0xffff, 10);
  end.writeUInt32LE(directory.length, 12);
  const file = Buffer.concat([directory, end]);
  const listing = await readZipListing(
    async (offset, length) => file.subarray(offset, offset + length),
    file.length,
  );
  expect(listing.files).toBe(0xffff);
  expect(listing.entries[0]?.name.length).toBe(512);
  expect(listing.entries[0]?.name.endsWith("…")).toBe(true);
});
