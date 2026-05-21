import { Logger } from '@nestjs/common';

let sdkRef: { shutdown: () => Promise<void> } | null = null;

export async function startTracing(logger: Logger): Promise<void> {
  if (process.env.OTEL_ENABLED === 'false') {
    logger.log('OpenTelemetry tracing disabled by OTEL_ENABLED=false');
    return;
  }

  try {
    // Lazy-require keeps runtime optional when OTEL deps are absent.
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const {
      CompositePropagator,
      W3CTraceContextPropagator,
      W3CBaggagePropagator,
    } = require('@opentelemetry/core');
    const { propagation } = require('@opentelemetry/api');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
    const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
        ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ?? 'http://localhost:4318/v1/traces',
    });

    const sdk = new NodeSDK({
      traceExporter: exporter,
      instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
    });

    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    );

    await sdk.start();
    sdkRef = sdk;
    logger.log('OpenTelemetry tracing initialized with OTLP exporter');
  } catch (error) {
    logger.warn(
      `OpenTelemetry tracing bootstrap skipped: ${(error as Error).message}`,
    );
  }
}

export async function stopTracing(logger: Logger): Promise<void> {
  if (!sdkRef) return;
  try {
    await sdkRef.shutdown();
    logger.log('OpenTelemetry tracing stopped');
  } catch (error) {
    logger.warn(`OpenTelemetry tracing shutdown failed: ${(error as Error).message}`);
  } finally {
    sdkRef = null;
  }
}
