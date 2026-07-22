import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SAFE_ALLOW_EXTENSION_ID } from "./config-schema";
import { redactSecrets } from "./redaction";

function logPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const dir = join(agentDir, "extensions", SAFE_ALLOW_EXTENSION_ID, "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "safe-allow.jsonl");
}

/**
 * Events worth printing to the interactive console. Routine lifecycle /
 * retry noise stays JSONL-only so it does not pollute the TUI.
 *
 * Set PI_SAFE_ALLOW_VERBOSE=1 to surface every event on the console.
 */
const CONSOLE_EVENTS = new Set([
  "register.fail",
  "config.issue",
  "denial.circuit_breaker",
  "review.failure",
]);

function shouldSurfaceToConsole(event: string): boolean {
  if (process.env.PI_SAFE_ALLOW_VERBOSE === "1") return true;
  return CONSOLE_EVENTS.has(event);
}

/** Always-on diagnostic log so we can see register/authorize without UI. */
export function logSafeAllow(
  event: string,
  details: Record<string, unknown> = {},
): boolean {
  let written = false;
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      extension: SAFE_ALLOW_EXTENSION_ID,
      event,
      ...(redactSecrets(details) as Record<string, unknown>),
    });
    appendFileSync(logPath(), `${line}\n`, "utf-8");
    written = true;
  } catch {
    // never throw from logging
  }
  // Only surface exceptional events in interactive sessions by default.
  if (shouldSurfaceToConsole(event)) {
    try {
      console.warn(`[${SAFE_ALLOW_EXTENSION_ID}] ${event}`, details);
    } catch {
      // ignore
    }
  }
  return written;
}
