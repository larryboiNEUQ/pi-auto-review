import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  SAFE_ALLOW_EXTENSION_ID,
  type SafeAllowConfig,
  withDefaults,
} from "./config-schema";

const CONFIG_FILE_NAME = "config.json";

export interface ConfigIssue {
  path: string;
  message: string;
  sourcePath?: string;
}

export interface LoadConfigResult {
  config: SafeAllowConfig;
  issues: ConfigIssue[];
}

function defaultAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return join(homedir(), ".pi", "agent");
}

export function getGlobalConfigPath(agentDir = defaultAgentDir()): string {
  return join(
    agentDir,
    "extensions",
    SAFE_ALLOW_EXTENSION_ID,
    CONFIG_FILE_NAME,
  );
}

export function getProjectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "extensions", SAFE_ALLOW_EXTENSION_ID, CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLayer(
  path: string,
  issues: ConfigIssue[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed)) {
      issues.push({
        path: "$",
        message: "Expected a JSON object.",
        sourcePath: path,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      path: "$",
      message: `Failed to read config: ${message}`,
      sourcePath: path,
    });
    return undefined;
  }
}

/**
 * Load config with defaults. Missing files are fine — defaults still produce a
 * working safe-allow judge (unlike model-judge which no-ops without config).
 */
export function loadSafeAllowConfig(options?: {
  cwd?: string;
  agentDir?: string;
}): LoadConfigResult {
  const cwd = options?.cwd ?? process.cwd();
  const agentDir = options?.agentDir ?? defaultAgentDir();
  const issues: ConfigIssue[] = [];

  const global = readLayer(getGlobalConfigPath(agentDir), issues);
  const project = readLayer(getProjectConfigPath(cwd), issues);
  const merged = { ...(global ?? {}), ...(project ?? {}) };

  return { config: withDefaults(merged as Partial<SafeAllowConfig>), issues };
}
