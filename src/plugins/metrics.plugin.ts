import fp from 'fastify-plugin';
import {
  register,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import type { FastifyPluginAsync } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: AppMetrics;
  }
}

export interface AppMetrics {
  requestsTotal: Counter;
  redisDurationMs: Histogram;
  eventLoopLagMs: Gauge;
  heapUsedBytes: Gauge;
  activeTenants: Gauge;
  configReloadTotal: Counter;
  circuitOpen: Gauge;
}

const plugin: FastifyPluginAsync = async (app) => {
  // Collect default Node.js metrics (GC, event loop, heap, etc.)
  collectDefaultMetrics({ register });

  const metrics: AppMetrics = {
    requestsTotal: new Counter({
      name: 'rl_requests_total',
      help: 'Total rate limit decisions',
      labelNames: ['tenant_id', 'route', 'algorithm', 'result'],
    }),
    redisDurationMs: new Histogram({
      name: 'rl_redis_duration_ms',
      help: 'Redis Lua script round-trip latency in milliseconds',
      labelNames: ['algorithm', 'script'],
      buckets: [0.5, 1, 2, 5, 10, 20, 50, 100],
    }),
    eventLoopLagMs: new Gauge({
      name: 'rl_event_loop_lag_ms',
      help: 'Node.js event loop lag in milliseconds per worker',
      labelNames: ['worker_id'],
    }),
    heapUsedBytes: new Gauge({
      name: 'rl_heap_used_bytes',
      help: 'V8 heap used bytes per worker',
      labelNames: ['worker_id'],
    }),
    activeTenants: new Gauge({
      name: 'rl_active_tenants',
      help: 'Number of tenants with active Redis keys',
    }),
    configReloadTotal: new Counter({
      name: 'rl_config_reload_total',
      help: 'Config cache invalidations from pub/sub or resync',
      labelNames: ['trigger', 'worker_id'],
    }),
    circuitOpen: new Gauge({
      name: 'rl_circuit_open',
      help: '1 if Redis circuit breaker is open, 0 otherwise',
      labelNames: ['worker_id'],
    }),
  };

  app.decorate('metrics', metrics);

  // Event loop lag monitor — measures how late setInterval fires vs scheduled time.
  // If consistently > 50ms, synchronous code is blocking the hot path.
  const workerId = String(process.env['worker_id'] ?? '0');
  const INTERVAL = 500;
  let last = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - last - INTERVAL);
    metrics.eventLoopLagMs.set({ worker_id: workerId }, lag);
    metrics.heapUsedBytes.set({ worker_id: workerId }, process.memoryUsage().heapUsed);
    last = now;
  }, INTERVAL);
  lagTimer.unref();

  // Expose /metrics endpoint (Prometheus text format)
  app.get('/metrics', { logLevel: 'warn' }, async (_req, reply) => {
    const metrics = await register.metrics();
    return reply.header('Content-Type', register.contentType).send(metrics);
  });
};

export const metricsPlugin = fp(plugin, { name: 'metrics' });
