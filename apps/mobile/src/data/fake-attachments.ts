// C16 sample answers: attachment.preview for files picked in sample mode. Sample paths don't
// exist, so the answer is made-up content of the file's kind.
import { fileMimeType, filePreviewKind } from "@zoltbot/protocol";
import type { Row } from "./transport.js";

const SAMPLES: Record<string, string> = {
  csv: "region,units,revenue\nNorth,42,$12,400\nSouth,37,$10,950\nEast,51,$15,300\nWest,29,$8,700\n",
  tsv: "region\tunits\nNorth\t42\nSouth\t37\n",
  markdown: "# Sample notes\n\n- First point\n- Second point\n",
  text: "Sample text file.\n",
  svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120">' +
    '<rect x="20" y="60" width="30" height="50" fill="#3b82f6"/>' +
    '<rect x="70" y="30" width="30" height="80" fill="#3b82f6"/>' +
    '<rect x="120" y="45" width="30" height="65" fill="#3b82f6"/></svg>',
};

// A one-page PDF and a one-second video, made for sample mode, as base64.
const PDF =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPD" +
  "wgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1Bh" +
  "Z2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcy" +
  "A8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NCA+PgpzdHJl" +
  "YW0KQlQgL0YxIDE4IFRmIDMwIDExMCBUZCAoU2FtcGxlIHJlcG9ydCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1ID" +
  "Agb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoK" +
  "eHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbi" +
  "AKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzUgMDAwMDAgbiAKdHJhaWxl" +
  "cgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDUKJSVFT0YK";
const VIDEO =
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANUbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAABL" +
  "AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAgAAAn90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAABLAAAAAAAAAAAAAAAAAAAA" +
  "AAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA" +
  "AAEAAASwAAAAAAABAAAAAAH3bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAMABVxAAAAAAALWhkbHIAAAAAAA" +
  "AAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABom1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5m" +
  "AAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWJzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAA" +
  "EAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAA" +
  "GP//AAAAMGF2Y0MBQsAK/+EAGGdCwArZAo35MBEAAAMAAQAAAwAUDxImSAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQ" +
  "AAABRidHJ0AAAAAAAAGQ0AAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAwAAAQAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAc" +
  "c3RzYwAAAAAAAAABAAAAAQAAAAwAAAABAAAARHN0c3oAAAAAAAAAAAAAAAwAAANTAAAACgAAAAsAAAAKAAAACgAAAA" +
  "oAAAAKAAAACgAAAAoAAAAKAAAACgAAAAoAAAAUc3RjbwAAAAAAAAABAAADhAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAA" +
  "IWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNj" +
  "EuNy4xMDAAAAAIZnJlZQAAA8ptZGF0AAACcQYF//9t3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NCByMzEw" +
  "OCAzMWUxOWY5IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyMyAtIGh0dHA6Ly93d3" +
  "cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFs" +
  "eXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3" +
  "JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bz" +
  "a2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZW" +
  "Fkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJh" +
  "PTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcm" +
  "VmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0w" +
  "IHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAADaZYiED/EYoAAg0xwABLmjgACObJ" +
  "ycnJycnJycnX/jh/BWCDigACB1CBBDACwoGKCgBWmwMRhtqLAQEMlgICMYE0RS9qLIBmSyAbG0Kfj4f6BULCC4KYEo" +
  "CFgCi0gIdptqlgQFYgQo2J2qWIBMJghrrrrrrpgqc0FccGOGnp666666+H/DAGCoEAQQXzAkCwuAKLSAhXm2osCApn" +
  "AhRkbtRYgEZa/w8fsFUIEF4wKBcXBwICmQBWkwMVxtqwcQCMgTxEftSYIa666666Wlpa6666666666666668AAAAAG" +
  "QZo4H+D2AAAAB0GaVAf4PYAAAAAGQZpgP8HsAAAABkGagD/B7AAAAAZBmqA/wewAAAAGQZrAP8HsAAAABkGa4D/B7A" +
  "AAAAZBmwA/wewAAAAGQZsgP8HsAAAABkGbQDvB7AAAAAZBm2A3wew=";
const BINARY: Record<string, string> = { pdf: PDF, video: VIDEO };

export function answerAttachmentPreview(items: readonly Row[], p: Row): Row {
  const item = items.find((row) => row.id === p.itemId && row.threadId === p.threadId);
  const body = (item?.body ?? {}) as Row;
  const part = Array.isArray(body.input)
    ? ((body.input as Row[])[Number(p.part)] as Row)
    : undefined;
  if (item?.kind !== "user" || body.origin === "agent" || !part)
    throw new Error("attachment_preview_unavailable");
  if (part.type === "image" && typeof part.base64 === "string") {
    const size = Math.floor((part.base64.length * 3) / 4);
    const mime = typeof part.mimeType === "string" ? part.mimeType : "image/jpeg";
    return {
      kind: "image",
      name: "Photo",
      mime,
      size,
      stamp: "sample",
      data: part.base64,
      next: null,
    };
  }
  const path = typeof part.path === "string" ? part.path : "";
  const kind = filePreviewKind(path);
  const binary = BINARY[kind];
  if (part.type === "file" && binary !== undefined)
    return {
      kind,
      name: path.split("/").pop() ?? "",
      mime: fileMimeType(path),
      size: atob(binary).length,
      stamp: "sample",
      data: binary,
      next: null,
    };
  const data = SAMPLES[kind];
  if (part.type !== "file" || data === undefined) throw new Error("attachment_preview_unavailable");
  return {
    kind,
    name: path.split("/").pop() ?? "",
    mime: fileMimeType(path),
    size: data.length,
    stamp: "sample",
    data,
    next: null,
  };
}
