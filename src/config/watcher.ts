import type { Redis } from 'ioredis';
import type { RuleCache } from './cache.js';
import type { RedisStore } from '../store/redis.js';
import type { Rule } from '../types/index.js';
import { RuleSchema } from './model.js';

export const CONFIG_CHANNEL = 'rl:config:updates';

export interface ConfigUpdateEvent {
  action: 'upsert' | 'delete';
  tenantId: string;
  route?: string;
  rule?: Rule;
}

// Subscribes to Redis pub/sub for config updates and invalidates the in-process LRU cache.
// Each cluster worker runs its own watcher on a dedicated ioredis subscriber connection.
export class ConfigWatcher {
  private sub: Redis | null = null;
  private reloadCount = 0;

  constructor(
    private store: RedisStore,
    private cache: RuleCache,
    private workerId: number,
  ) {}

  async start(intervalMs = 30_000): Promise<void> {
    this.sub = await this.store.createSubscriber();
    await this.sub.subscribe(CONFIG_CHANNEL);

    this.sub!.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message) as ConfigUpdateEvent;
        this.handleEvent(event);
      } catch {
        // Ignore malformed messages
      }
    });

    // Full resync on interval as a failsafe if pub/sub messages are missed
    setInterval(() => {
      void this.fullResync();
    }, intervalMs).unref();
  }

  private handleEvent(event: ConfigUpdateEvent): void {
    this.reloadCount++;
    if (event.action === 'delete') {
      this.cache.invalidate(event.tenantId, event.route);
    } else if (event.action === 'upsert' && event.rule) {
      this.cache.set(event.rule);
    }
  }

  // Full resync: fetch all rules from Redis and reload the cache.
  async fullResync(): Promise<void> {
    try {
      const rules = await this.fetchAllRules();
      this.cache.clear();
      this.cache.load(rules);
      this.reloadCount++;
    } catch {
      // Redis unavailable — cache retains stale data until next resync
    }
  }

  private async fetchAllRules(): Promise<Rule[]> {
    const pattern = 'rl:cfg:*';
    const keys = await this.store.raw.keys(pattern);
    if (keys.length === 0) return [];

    const pipeline = this.store.raw.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = await pipeline.exec();
    if (!results) return [];

    // Redis hgetall returns all values as strings — parse through zod to restore types.
    // Without this, `dryRun: "false"` (string) is truthy and all limits are bypassed.
    return results
      .filter(([err, val]) => !err && val !== null)
      .flatMap(([, val]) => {
        const parsed = RuleSchema.safeParse(val);
        return parsed.success ? [parsed.data as Rule] : [];
      });
  }

  get stats() {
    return { workerId: this.workerId, reloadCount: this.reloadCount };
  }

  async stop(): Promise<void> {
    if (!this.sub) return;
    await this.sub.unsubscribe(CONFIG_CHANNEL);
    await this.sub.quit();
  }
}
