import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

export type ReviewerModelSource = "Project" | "Global" | "built-in default";

export interface LoadConfigResult {
  config: SafeAllowConfig;
  issues: ConfigIssue[];
  reviewerModelSource?: ReviewerModelSource;
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

function loadPolicyOverride(
  layer: Record<string, unknown>,
  configPath: string,
  issues: ConfigIssue[],
): Record<string, unknown> {
  if (!("policyPath" in layer)) {
    const sanitized = { ...layer };
    delete sanitized.policy;
    return sanitized;
  }
  if (typeof layer.policyPath !== "string" || !layer.policyPath.trim()) {
    issues.push({
      path: "$.policyPath",
      message: "Expected a non-empty policy file path.",
      sourcePath: configPath,
    });
    return { ...layer, policyLoadFailed: true };
  }

  const configuredPath = layer.policyPath.trim();
  const policyPath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(dirname(configPath), configuredPath);
  try {
    const policy = readFileSync(policyPath, "utf-8").trim();
    if (!policy) {
      issues.push({
        path: "$.policyPath",
        message: "Guardian policy file must not be empty.",
        sourcePath: policyPath,
      });
      return { ...layer, policyLoadFailed: true };
    }
    return { ...layer, policy, policyLoadFailed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push({
      path: "$.policyPath",
      message: `Failed to read Guardian policy: ${message}`,
      sourcePath: policyPath,
    });
    return { ...layer, policyLoadFailed: true };
  }
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
    return loadPolicyOverride(parsed, path, issues);
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

  const config = withDefaults(merged as Partial<SafeAllowConfig>);
  if (merged.policyLoadFailed === true) config.disabled = true;
  const definesReviewerModel = (layer: Record<string, unknown> | undefined) =>
    typeof layer?.provider === "string" || typeof layer?.model === "string";
  const reviewerModelSource: ReviewerModelSource = definesReviewerModel(project)
    ? "Project"
    : definesReviewerModel(global)
      ? "Global"
      : "built-in default";
  return { config, issues, reviewerModelSource };
}
