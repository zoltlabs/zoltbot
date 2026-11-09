/** Keep the virtualizer's key reader stable while only row content changes. */
export function createTimelineKeys() {
  let keys: string[] = [];
  let read = (index: number): string | number => index;
  return (rows: readonly { key: string }[]) => {
    if (keys.length !== rows.length || keys.some((key, index) => key !== rows[index]?.key)) {
      const next = rows.map((row) => row.key);
      keys = next;
      read = (index) => next[index] ?? index;
    }
    return read;
  };
}
