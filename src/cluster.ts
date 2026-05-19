import cluster from 'node:cluster';
import os from 'node:os';

const WORKERS = parseInt(process.env['WORKERS'] ?? String(os.cpus().length), 10);

if (cluster.isPrimary) {
  console.log(`[Primary ${process.pid}] starting ${WORKERS} workers`);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork({ worker_id: String(i) });
  }

  cluster.on('exit', (worker, code, signal) => {
    const reason = signal ?? code;
    console.error(`[Primary] worker ${worker.process.pid} died (${reason}), restarting...`);
    cluster.fork({ worker_id: String(worker.id) });
  });

  // Unhandled rejections in primary should not crash the supervisor
  process.on('unhandledRejection', (reason) => {
    console.error('[Primary] unhandled rejection:', reason);
  });
} else {
  // Each worker imports app dynamically so primary process stays lean
  const { createApp, buildConfig } = await import('./app.js');

  // Global safety net — unhandled rejections crash the worker, primary will restart it
  process.on('unhandledRejection', (reason) => {
    console.error(`[Worker ${process.pid}] unhandled rejection:`, reason);
    process.exit(1);
  });

  const config = buildConfig();
  const app = await createApp(config);
  await app.listen({ port: config.port, host: config.host });
  console.log(`[Worker ${process.pid}] listening on ${config.host}:${config.port}`);
}
