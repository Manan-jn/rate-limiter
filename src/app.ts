import Fastify from 'fastify';
import { RedisStore } from './store/redis.js';
import { BreakerStore } from './store/breaker.js';
import { RuleCache } from './config/cache.js';
import { ConfigWatcher } from './config/watcher.js';
import { buildAlgorithmRegistry } from './algorithms/index.js';
import { Dispatcher } from './limiter/dispatcher.js';
import { DenyCache } from './limiter/deny-cache.js';
import { rateLimitPlugin } from './middleware/rate-limit.middleware.js';
import { metricsPlugin } from './plugins/metrics.plugin.js';
import { otelPlugin } from './plugins/otel.plugin.js';
import { healthRoutes } from './routes/health.js';
import { adminRoutes } from './routes/admin.js';
import type { RateLimitConfig } from './middleware/rate-limit.middleware.js';

export interface AppConfig {
  redisUrl: string;
  port: number;
  host: string;
  workerId: number;
  rateLimitConfig: RateLimitConfig;
  configSyncIntervalMs: number;
}

export function buildConfig(): AppConfig {
  return {
    redisUrl: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    port: Number(process.env['PORT'] ?? 8080),
    host: process.env['HOST'] ?? '0.0.0.0',
    workerId: Number(process.env['worker_id'] ?? 0),
    configSyncIntervalMs: Number(process.env['CONFIG_SYNC_INTERVAL_MS'] ?? 30_000),
    rateLimitConfig: {
      keyExtractor: 'ip',
      failStrategy: (process.env['FAIL_STRATEGY'] ?? 'open') === 'closed' ? 'closed' : 'open',
    },
  };
}

export async function createApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
    },
    trustProxy: true,
  });

  // Shared infrastructure
  const store = new RedisStore(config.redisUrl);
  await store.connect();

  const cache = new RuleCache();
  const breaker = new BreakerStore(store);
  const algorithms = buildAlgorithmRegistry(breaker);
  const denyCache = new DenyCache();
  const dispatcher = new Dispatcher(store, cache, algorithms, denyCache);
  const watcher = new ConfigWatcher(store, cache, config.workerId);

  // Register on Fastify instance for use in plugins and routes
  app.decorate('dispatcher', dispatcher);
  app.decorate('redisStore', store);
  app.decorate('rateLimitConfig', config.rateLimitConfig);

  // Start config watcher (pub/sub hot-reload + periodic resync)
  await watcher.start(config.configSyncIntervalMs);
  // Perform initial full sync to populate cache from Redis
  await watcher.fullResync();

  // Plugins
  await app.register(otelPlugin);
  await app.register(metricsPlugin);
  await app.register(rateLimitPlugin);

  // Routes
  await app.register(healthRoutes);
  await app.register(adminRoutes, { prefix: '/api/v1' });

  // Graceful shutdown
  const shutdown = async () => {
    await app.close();
    await watcher.stop();
    await store.disconnect();
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });

  return app;
}
