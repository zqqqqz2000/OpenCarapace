import fs from "node:fs";
import path from "node:path";

export type TelemetryEvent = {
  type: string;
  at?: string;
  [key: string]: unknown;
};

export interface TelemetrySink {
  log(event: TelemetryEvent): void;
  child(scope: string, extra?: Record<string, unknown>): TelemetrySink;
}

class NoopTelemetrySink implements TelemetrySink {
  log(_event: TelemetryEvent): void {}

  child(_scope: string, _extra?: Record<string, unknown>): TelemetrySink {
    return this;
  }
}

class JsonlTelemetrySink implements TelemetrySink {
  constructor(
    private readonly filePath: string,
    private readonly scope?: string,
    private readonly extra?: Record<string, unknown>,
  ) {}

  log(event: TelemetryEvent): void {
    const payload: Record<string, unknown> = {
      at: event.at ?? new Date().toISOString(),
      pid: process.pid,
      ...event,
    };
    if (this.scope) {
      payload.scope = this.scope;
    }
    if (this.extra) {
      Object.assign(payload, this.extra);
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(payload)}\n`, "utf-8");
    } catch {
      // Telemetry failures must never break runtime behavior.
    }
  }

  child(scope: string, extra?: Record<string, unknown>): TelemetrySink {
    const mergedScope = this.scope ? `${this.scope}.${scope}` : scope;
    const mergedExtra = {
      ...(this.extra ?? {}),
      ...(extra ?? {}),
    };
    return new JsonlTelemetrySink(this.filePath, mergedScope, mergedExtra);
  }
}

let activeTelemetrySink: TelemetrySink = new NoopTelemetrySink();

export function getTelemetrySink(): TelemetrySink {
  return activeTelemetrySink;
}

export function setTelemetrySink(sink: TelemetrySink): void {
  activeTelemetrySink = sink;
}

export function configureTelemetry(params: {
  enabled: boolean;
  filePath: string;
}): TelemetrySink {
  if (!params.enabled) {
    const sink = new NoopTelemetrySink();
    setTelemetrySink(sink);
    return sink;
  }
  const sink = new JsonlTelemetrySink(path.resolve(params.filePath));
  setTelemetrySink(sink);
  sink.log({
    type: "telemetry.configured",
    filePath: path.resolve(params.filePath),
  });
  return sink;
}
