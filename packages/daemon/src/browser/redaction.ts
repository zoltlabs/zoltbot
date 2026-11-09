export function redactBrowserText(text: string) {
  return text.replace(/https?:\/\/[^\s<>"'`]+/g, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "REDACTED");
      if (url.hash) url.hash = "#REDACTED";
      return url.toString();
    } catch {
      return "[invalid URL]";
    }
  });
}
