import path from "node:path";

const textTypes: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".csv": "text/csv",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};
export function verifiedType(name: string, bytes: Buffer) {
  const ext = path.extname(name).toLowerCase();
  if (
    ext === ".png" &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0
  )
    return "image/png";
  if (
    [".jpg", ".jpeg"].includes(ext) &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    return "image/jpeg";
  if (
    ext === ".webp" &&
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  )
    return "image/webp";
  if (
    ext === ".pdf" &&
    bytes.subarray(0, 5).toString() === "%PDF-" &&
    bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
  )
    return "application/pdf";
  if (
    ext === ".woff2" &&
    bytes.length >= 48 &&
    bytes.toString("ascii", 0, 4) === "wOF2" &&
    bytes.readUInt32BE(8) === bytes.length &&
    bytes.readUInt16BE(12) > 0 &&
    bytes.readUInt16BE(14) === 0 &&
    bytes.readUInt32BE(20) <= bytes.length - 48
  )
    return "font/woff2";
  const mime =
    textTypes[ext] ??
    (/^(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(path.basename(name)) ||
    [".key", ".pem"].includes(ext)
      ? "text/plain"
      : undefined);
  if (!mime) throw Error("artifact_type_denied");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32) || code === 11 || code === 12)
      throw Error("artifact_binary_text_denied");
  }
  if (mime === "application/json") JSON.parse(text);
  if (
    mime === "image/svg+xml" &&
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<svg\b[^>]*>[\s\S]*<\/svg>\s*$/.test(text)
  )
    throw Error("artifact_svg_invalid");
  return mime;
}
