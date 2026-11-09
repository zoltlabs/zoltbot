/** Internal writer reservations are held across asynchronous setup and released once. */
export class NativeWriters {
  private readonly keys = new Set<string>();
  acquire(key: string) {
    if (this.keys.has(key)) throw new Error("native_session_in_use");
    this.keys.add(key);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.keys.delete(key);
      }
    };
  }
}
