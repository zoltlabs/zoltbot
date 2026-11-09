import { randomInt } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const glyphs = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
];
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  body.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function raster(marker: string) {
  const width = 600,
    height = 160;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  for (const [i, digit] of [...marker].entries()) {
    const glyph = glyphs[Number(digit)];
    if (!glyph) throw Error("glyph");
    for (let gy = 0; gy < 5; gy++)
      for (let gx = 0; gx < 3; gx++)
        if (glyph[gy * 3 + gx] === "1")
          for (let yy = 0; yy < 18; yy++)
            for (let xx = 0; xx < 18; xx++) {
              const x = 35 + i * 100 + gx * 18 + xx,
                y = 30 + gy * 18 + yy;
              const offset = y * (width * 3 + 1) + 1 + x * 3;
              raw.fill(20, offset, offset + 3);
            }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Random digits exist only in server memory and raster pixels; never DOM, paths or agent prompts. */
export async function browserFixture(index: number) {
  const expected = Array.from({ length: 5 }, () => String(randomInt(2, 10))).join("");
  const pixels = raster(expected);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/pixels") {
      response.setHeader("Content-Type", "image/png");
      response.end(pixels);
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<!doctype html><html><body><h1>Local fixture ${index}</h1><img src="/pixels" alt="Visual challenge"><form onsubmit="event.preventDefault();localStorage.setItem('owner','task-${index}');document.querySelector('output').textContent='Submitted'"><label>Alias<input></label><button>Submit</button></form><output></output></body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  return { expected, server, url: `http://127.0.0.1:${address.port}` };
}
