import type { RedisStore } from './redis.js';
import type { Store } from '../types/index.js';

// Lightweight circuit breaker — replaces opossum to eliminate event-emitter overhead.
// opossum adds ~0.2ms per call via Promise wrapping and state-machine events.
// This implementation uses only atomic flag checks and a sliding error window.
export class BreakerStore implements Store {
  private errorCount = 0;
  private lastErrorTime = 0;
  public isOpen = false;

  private readonly threshold: number;     // errors before opening
  private readonly windowMs: number;      // error counting window
  private readonly resetMs: number;       // time before trying half-open

  constructor(
    private store: RedisStore,
    {
      threshold = 10,
      windowMs = 5_000,
      resetMs = 5_000,
    }: { threshold?: number; windowMs?: number; resetMs?: number } = {}
  ) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.resetMs = resetMs;
  }

  async evalsha<T>(name: string, keys: string[], args: (string | number)[]): Promise<T> {
    // Half-open: try again after resetMs
    if (this.isOpen) {
      if (Date.now() - this.lastErrorTime < this.resetMs) {
        throw new Error('Circuit open: Redis unavailable');
      }
      this.isOpen = false; // half-open probe
    }

    try {
      const result = await this.store.evalsha<T>(name, keys, args);
      // Success resets error count
      this.errorCount = 0;
      return result;
    } catch (err) {
      this.recordError();
      throw err;
    }
  }

  async nowMs(): Promise<number> {
    return this.store.nowMs();
  }

  private recordError(): void {
    const now = Date.now();
    // Reset counter if outside window
    if (now - this.lastErrorTime > this.windowMs) {
      this.errorCount = 0;
    }
    this.errorCount++;
    this.lastErrorTime = now;
    if (this.errorCount >= this.threshold) {
      this.isOpen = true;
    }
  }
}
