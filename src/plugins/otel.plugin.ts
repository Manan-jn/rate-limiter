import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

const plugin: FastifyPluginAsync = async (_app) => {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (!endpoint) return; // OTEL is opt-in

  // Dynamic import to avoid loading the full OTEL SDK when not configured
  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);

  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    })],
  });

  sdk.start();

  process.on('SIGTERM', () => {
    void sdk.shutdown();
  });
};

export const otelPlugin = fp(plugin, { name: 'otel' });
