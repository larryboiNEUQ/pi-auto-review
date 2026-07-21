/**
 * Allow-capable authorizer for external_directory only.
 * Fail-safe: errors → defer (human prompt).
 */

import type {
  Authorizer,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import type { SafeAllowConfig } from "./config-schema";
import { logSafeAllow } from "./log";
import {
  type CompleteFn,
  type ModelRegistryLike,
  reviewExternalPath,
} from "./model-review";

export interface SafeAllowReviewerDeps {
  getConfig: () => SafeAllowConfig | undefined;
  getRegistry: () => ModelRegistryLike | undefined;
  complete: CompleteFn;
}

export function createSafeAllowReviewer(
  deps: SafeAllowReviewerDeps,
): Authorizer["authorize"] {
  return async (details, _query) => {
    const config = deps.getConfig();
    if (!config || config.disabled) {
      logSafeAllow("authorize.defer", {
        reason: config?.disabled ? "disabled" : "no_config",
      });
      return { kind: "defer" };
    }

    if (!isExternalDirectoryAsk(details)) {
      logSafeAllow("authorize.defer", {
        reason: "not_external_directory",
        surface: surfaceOf(details),
        toolName: details.toolName ?? null,
      });
      return { kind: "defer" };
    }

    const path = pathOf(details);
    if (path === undefined || path.trim() === "") {
      logSafeAllow("authorize.defer", { reason: "no_path" });
      return { kind: "defer" };
    }

    const registry = deps.getRegistry();
    const model = registry?.find(config.provider, config.model);
    if (!model || !registry) {
      logSafeAllow("authorize.defer", {
        reason: "model_unresolved",
        provider: config.provider,
        model: config.model,
        hasRegistry: Boolean(registry),
      });
      return { kind: "defer" };
    }

    logSafeAllow("authorize.model_start", {
      path,
      toolName: details.toolName ?? null,
      provider: config.provider,
      model: config.model,
      timeoutMs: config.timeoutMs,
    });

    const started = Date.now();
    const verdict = await reviewExternalPath({
      path,
      toolName: details.toolName,
      message: details.message,
      config,
      model,
      registry,
      complete: deps.complete,
    });
    logSafeAllow("authorize.model_done", {
      path,
      verdict: verdict.kind,
      reason: verdict.kind === "deny" ? verdict.reason ?? null : null,
      durationMs: Date.now() - started,
    });
    return verdict;
  };
}

function isExternalDirectoryAsk(details: PromptPermissionDetails): boolean {
  if (surfaceOf(details) === "external_directory") {
    return true;
  }
  if (
    typeof details.message === "string" &&
    details.message.toLowerCase().includes("outside working directory")
  ) {
    return true;
  }
  return false;
}

function surfaceOf(details: PromptPermissionDetails): string | undefined {
  return details.accessIntent?.surface ?? details.surface ?? undefined;
}

function pathOf(details: PromptPermissionDetails): string | undefined {
  return details.path ?? details.value ?? undefined;
}
