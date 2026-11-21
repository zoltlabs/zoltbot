// C16: parses CSV and TSV off the main thread, so a big file never stalls the window.
import { parseDelimited } from "@zoltbot/protocol";

self.onmessage = (event: MessageEvent<{ text: string; delimiter: "," | "\t" }>) => {
  self.postMessage(parseDelimited(event.data.text, event.data.delimiter));
};
