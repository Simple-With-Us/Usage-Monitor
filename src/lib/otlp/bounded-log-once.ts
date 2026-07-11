/**
 * Bounded FIFO membership cache for process-local "log once" suppression.
 *
 * This is deliberately not an LRU: seeing a repeated key should not let one
 * noisy unknown metric hold a slot forever. Once capacity is reached, the
 * oldest first-seen key is evicted and may be logged again if it reappears.
 */
export class BoundedLogOnce {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive safe integer");
    }
  }

  remember(key: string): boolean {
    if (this.seen.has(key)) return false;

    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    this.seen.add(key);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
