// UTF-8 boundary handling adapted from T3 Code terminalOutput.ts at
// 25bf84ab07f53f141c20239c63e383823a9d5ea0. See docs/third-party/t3-terminal-MIT.txt.
const MAX_BYTES = 512 * 1024;
const MAX_CHUNKS = 2048;
const MAX_LINES = 5000;
export class TerminalOutputBuffer {
  private chunks: { data: Buffer; lines: number }[] = [];
  private bytes = 0;
  private lines = 0;
  offset = 0;
  append(text: string) {
    const data = Buffer.from(text);
    this.offset += data.length;
    // Bound chunks as well as bytes, including single-byte PTY callbacks.
    for (let offset = 0; offset < data.length; ) {
      let end = Math.min(offset + 16384, data.length);
      while (end < data.length && ((data[end] ?? 0) & 0xc0) === 0x80) end--;
      const part = Buffer.from(data.subarray(offset, end));
      const lines = part.reduce((count, byte) => count + Number(byte === 10), 0);
      this.chunks.push({ data: part, lines });
      this.bytes += part.length;
      this.lines += lines;
      offset = end;
    }
    while (this.bytes > MAX_BYTES || this.chunks.length > MAX_CHUNKS || this.lines > MAX_LINES) {
      const first = this.chunks.shift();
      if (!first) break;
      this.bytes -= first.data.length;
      this.lines -= first.lines;
    }
  }
  read(offset: number) {
    const start = this.offset - this.bytes;
    let position = start;
    const selected: Buffer[] = [];
    let bytes = 0,
      nextOffset = Math.max(offset, start);
    for (const chunk of this.chunks) {
      if (position + chunk.data.length <= nextOffset) {
        position += chunk.data.length;
        continue;
      }
      let from = Math.max(nextOffset - position, 0);
      while (from < chunk.data.length && ((chunk.data[from] ?? 0) & 0xc0) === 0x80) from++;
      let end = Math.min(from + 32768 - bytes, chunk.data.length);
      while (end < chunk.data.length && ((chunk.data[end] ?? 0) & 0xc0) === 0x80) end--;
      selected.push(chunk.data.subarray(from, end));
      bytes += end - from;
      nextOffset = position + end;
      if (end < chunk.data.length || bytes === 32768) break;
      position += chunk.data.length;
    }
    return {
      data: Buffer.concat(selected, bytes).toString("utf8"),
      offset: nextOffset,
      truncated: offset < start,
      caughtUp: nextOffset === this.offset,
    };
  }
}
