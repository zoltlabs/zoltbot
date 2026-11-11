/** Scheme paths cannot contain URL syntax, alternate separators or dot segments. */
export function validBundlePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\:#?%]/.test(value) &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
