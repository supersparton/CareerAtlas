import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { context, propagation, trace, ROOT_CONTEXT } from '@opentelemetry/api';

// Create Prometheus metrics exporter (server on port 9464)
const prometheusExporter = new PrometheusExporter({
  port: 9464,
});

// Create gRPC OTLP trace exporter
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4317',
});

// Initialize NodeSDK
const sdk = new NodeSDK({
  serviceName: 'careeratlas-backend',
  traceExporter,
  metricReader: prometheusExporter,
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new NestInstrumentation(),
    new IORedisInstrumentation(),
    new PgInstrumentation(),
  ],
});

sdk.start();

console.log('[OTEL] OpenTelemetry SDK initialized. Prometheus metrics server running on port 9464.');

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('[OTEL] SDK shut down successfully'))
    .catch((err) => console.error('[OTEL] Error shutting down SDK', err))
    .finally(() => process.exit(0));
});

// Helpers for queue distributed context propagation
export function injectTraceContext<T extends Record<string, any>>(payload: T): T & { traceparent?: string; tracestate?: string } {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return { ...payload, ...carrier };
}

export function extractTraceContext(carrier: Record<string, any>) {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

export const tracer = trace.getTracer('careeratlas-backend');
