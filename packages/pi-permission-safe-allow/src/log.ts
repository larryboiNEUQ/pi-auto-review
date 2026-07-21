import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SAFE_ALLOW_EXTENSION_ID } from "./config-schema";

function logPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const dir = join(agentDir, "extensions", SAFE_ALLOW_EXTENSION_ID, "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "safe-allow.jsonl");
}

/** Always-on diagnostic log so we can see register/authorize without UI. */
export function logSafeAllow(
  event: string,
  details: Record<string, unknown> = {},
): void {
  try {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      extension: SAFE_ALLOW_EXTENSION_ID,
      event,
      ...details,
    });
    appendFileSync(logPath(), `${line}\n`, "utf-8");
  } catch {
    // never throw from logging
  }
  // also surface in console for interactive pi sessions
  try {
    console.warn(`[${SAFE_ALLOW_EXTENSION_ID}] ${event}`, details);
  } catch {
    // ignore
  }
}
