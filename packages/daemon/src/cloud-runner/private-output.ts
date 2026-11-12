import { Redactor } from "../logging.js";

/** Bounded streaming text. Credentials and retained prefixes stay in closures, never JSON fields. */
export function privateOutput() {
  let redactor = new Redactor();
  const prefixes = new Map<string, Int32Array>();
  const pending = { stdout: "", stderr: "" };
  return {
    register(value: string) {
      if (!value || prefixes.has(value)) return;
      redactor.register(value);
      const prefix = new Int32Array(value.length);
      for (let i = 1, matched = 0; i < value.length; i++) {
        while (matched && value[i] !== value[matched]) matched = prefix[matched - 1] ?? 0;
        if (value[i] === value[matched]) matched++;
        prefix[i] = matched;
      }
      prefixes.set(value, prefix);
    },
    text(stream: "stdout" | "stderr", data: string, complete = false) {
      // Replace complete values first so repeated overlapping secrets cannot grow the retained tail.
      const visible = redactor.text(pending[stream] + data);
      let cut = visible.length;
      if (!complete)
        for (const [secret, prefix] of prefixes) {
          if (secret.length < 2) continue;
          let matched = 0;
          for (let i = Math.max(0, visible.length - secret.length + 1); i < visible.length; i++) {
            while (matched && visible[i] !== secret[matched]) matched = prefix[matched - 1] ?? 0;
            if (visible[i] === secret[matched]) matched++;
          }
          cut = Math.min(cut, visible.length - matched);
        }
      pending[stream] = visible.slice(cut);
      return visible.slice(0, cut);
    },
    clear() {
      pending.stdout = "";
      pending.stderr = "";
      prefixes.clear();
      redactor = new Redactor();
    },
  };
}
