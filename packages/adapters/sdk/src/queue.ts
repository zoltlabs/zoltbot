export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: ((value: IteratorResult<T>) => void)[] = [];
  private readonly writers: (() => void)[] = [];
  private ended = false;
  constructor(private readonly capacity = 256) {
    if (capacity < 1) throw new Error("queue capacity must be positive");
  }
  async push(value: T) {
    while (!this.ended && this.values.length >= this.capacity)
      await new Promise<void>((resolve) => this.writers.push(resolve));
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) reader({ value, done: false });
    else this.values.push(value);
  }
  close() {
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
    for (const writer of this.writers.splice(0)) writer();
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          this.writers.shift()?.();
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.readers.push(resolve));
      },
    };
  }
}
