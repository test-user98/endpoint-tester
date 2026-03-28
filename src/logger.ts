import { appendFileSync, writeFileSync } from "fs";

/**
 * Structured logger that writes to debug.log with timestamps and per-endpoint tracing.
 * Each log entry is tagged with the endpoint slug for easy filtering/debugging.
 */

const LOG_FILE = "debug.log";

export type LogLevel = "INFO" | "DEBUG" | "WARN" | "ERROR" | "TRACE";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  endpoint: string;
  phase: string;
  message: string;
  data?: unknown;
  durationMs?: number;
}

/** Initialize the log file (clears previous run) */
export function initLogger(): void {
  writeFileSync(LOG_FILE, `=== Endpoint Tester Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`);
}

/** Core logging function — writes structured entry to debug.log */
function writeLog(entry: LogEntry): void {
  const ts = entry.timestamp;
  const dur = entry.durationMs != null ? ` (${entry.durationMs}ms)` : "";
  const dataStr = entry.data != null ? `\n    data: ${JSON.stringify(entry.data, null, 2).split("\n").join("\n    ")}` : "";

  const line = `[${ts}] [${entry.level.padEnd(5)}] [${entry.endpoint}] [${entry.phase}] ${entry.message}${dur}${dataStr}\n`;
  appendFileSync(LOG_FILE, line);
}

/**
 * Creates a scoped logger for a specific endpoint agent.
 * All log calls are automatically tagged with the endpoint slug.
 */
export function createEndpointLogger(slug: string) {
  return {
    info(phase: string, message: string, data?: unknown) {
      writeLog({ timestamp: new Date().toISOString(), level: "INFO", endpoint: slug, phase, message, data });
    },
    debug(phase: string, message: string, data?: unknown) {
      writeLog({ timestamp: new Date().toISOString(), level: "DEBUG", endpoint: slug, phase, message, data });
    },
    warn(phase: string, message: string, data?: unknown) {
      writeLog({ timestamp: new Date().toISOString(), level: "WARN", endpoint: slug, phase, message, data });
    },
    error(phase: string, message: string, data?: unknown) {
      writeLog({ timestamp: new Date().toISOString(), level: "ERROR", endpoint: slug, phase, message, data });
    },
    trace(phase: string, message: string, data?: unknown, durationMs?: number) {
      writeLog({ timestamp: new Date().toISOString(), level: "TRACE", endpoint: slug, phase, message, data, durationMs });
    },
  };
}

export type EndpointLogger = ReturnType<typeof createEndpointLogger>;
