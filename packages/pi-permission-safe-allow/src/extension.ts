/**
 * Register the "safe-allow" authorizer link once config + permissions service
 * are ready. Retries registration because load order vs permissions:ready varies.
 */

import { complete as realComplete } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getPermissionsService,
  PERMISSIONS_READY_CHANNEL,
} from "@gotgenes/pi-permission-system";

import { type LoadConfigResult, loadSafeAllowConfig } from "./config-loader";
import {
  SAFE_ALLOW_EXTENSION_ID,
  SAFE_ALLOW_LINK_NAME,
  type SafeAllowConfig,
} from "./config-schema";
import { logSafeAllow } from "./log";
import { DenialLifecycle } from "./denial-lifecycle";
import type { CompleteFn, ModelRegistryLike } from "./model-review";
import { createSafeAllowReviewer } from "./safe-allow-reviewer";

export interface SafeAllowDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  complete?: CompleteFn;
}

export function createSafeAllowExtension(
  pi: ExtensionAPI,
  dependencies: SafeAllowDependencies = {},
): void {
  const loadConfig =
    dependencies.loadConfig ?? ((cwd: string) => loadSafeAllowConfig({ cwd }));
  const complete: CompleteFn =
    dependencies.complete ??
    ((model, context, options) => realComplete(model, context, options));

  let sessionStarted = false;
  let config: SafeAllowConfig | undefined;
  let registry: ModelRegistryLike | undefined;
  let currentContext: ExtensionContext | undefined;
  let dispose: (() => void) | undefined;
  const lifecycle = new DenialLifecycle();
  const retryTimers: ReturnType<typeof setTimeout>[] = [];

  function clearRetries(): void {
    while (retryTimers.length > 0) {
      const t = retryTimers.pop();
      if (t) clearTimeout(t);
    }
  }

  function tryRegister(source: string): void {
    if (!sessionStarted || !config) {
      logSafeAllow("register.skip", {
        source,
        reason: !sessionStarted ? "session_not_started" : "no_config",
      });
      return;
    }
    if (dispose) {
      logSafeAllow("register.skip", { source, reason: "already_registered" });
      return;
    }

    const service = getPermissionsService();
    if (!service) {
      logSafeAllow("register.skip", {
        source,
        reason: "permissions_service_missing",
      });
      return;
    }

    if (typeof service.registerAuthorizer !== "function") {
      logSafeAllow("register.fail", {
        source,
        reason: "no_registerAuthorizer_api",
      });
      return;
    }

    const authorize = createSafeAllowReviewer({
      getConfig: () => config,
      getRegistry: () => registry,
      getEvidence: () => currentContext?.sessionManager.getEntries() ?? [],
      getSignal: () => currentContext?.signal,
      lifecycle,
      complete,
      onCircuitBreaker: (kind) => {
        logSafeAllow("denial.circuit_breaker", { kind });
        currentContext?.ui.notify(
          `Delegated approval stopped this turn after repeated denials (${kind}).`,
          "warning",
        );
        currentContext?.abort();
      },
    });

    try {
      dispose = service.registerAuthorizer(SAFE_ALLOW_LINK_NAME, authorize);
      logSafeAllow("register.ok", {
        source,
        link: SAFE_ALLOW_LINK_NAME,
        provider: config.provider,
        model: config.model,
        hasRegistry: Boolean(registry),
        modelResolves: Boolean(registry?.find(config.provider, config.model)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If already registered by a prior attempt, treat as ok
      if (/already registered/i.test(message)) {
        logSafeAllow("register.ok", {
          source,
          link: SAFE_ALLOW_LINK_NAME,
          note: "already_registered_error",
        });
        dispose = () => {
          /* no-op disposer for sticky registration */
        };
        return;
      }
      logSafeAllow("register.fail", { source, error: message });
    }
  }

  function scheduleRetries(source: string): void {
    for (const ms of [0, 50, 200, 500, 1500]) {
      retryTimers.push(
        setTimeout(() => {
          tryRegister(`${source}+${ms}ms`);
        }, ms),
      );
    }
  }

  pi.on("session_start", (_event, ctx) => {
    const result = loadConfig(ctx.cwd);
    config = result.config;
    registry = ctx.modelRegistry as ModelRegistryLike | undefined;
    currentContext = ctx;
    lifecycle.resetSession();
    sessionStarted = true;
    dispose = undefined;
    clearRetries();

    logSafeAllow("session_start", {
      cwd: ctx.cwd,
      provider: config.provider,
      model: config.model,
      hasRegistry: Boolean(registry),
      modelResolves: Boolean(registry?.find(config.provider, config.model)),
      servicePresent: Boolean(getPermissionsService()),
      issues: result.issues,
    });

    for (const issue of result.issues) {
      logSafeAllow("config.issue", {
        path: issue.path,
        message: issue.message,
        sourcePath: issue.sourcePath ?? null,
      });
    }

    tryRegister("session_start");
    scheduleRetries("session_start");
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    logSafeAllow("permissions_ready", {
      sessionStarted,
      servicePresent: Boolean(getPermissionsService()),
    });
    tryRegister("permissions_ready");
    scheduleRetries("permissions_ready");
  });

  pi.on("session_shutdown", () => {
    clearRetries();
    dispose?.();
    dispose = undefined;
    sessionStarted = false;
    config = undefined;
    registry = undefined;
    currentContext = undefined;
    lifecycle.resetSession();
    logSafeAllow("session_shutdown", {});
  });

  logSafeAllow("extension_loaded", {
    id: SAFE_ALLOW_EXTENSION_ID,
    link: SAFE_ALLOW_LINK_NAME,
  });

  pi.on("turn_start", (_event, ctx) => {
    currentContext = ctx;
    lifecycle.resetTurn();
  });

  pi.registerCommand("approve", {
    description: "Authorize one exact retry of a recent delegated-review denial",
    handler: async (args, ctx) => {
      const recent = lifecycle.recentDenials();
      if (recent.length === 0) {
        ctx.ui.notify("There are no recent delegated-review denials.", "info");
        return;
      }
      let denialId = args.trim();
      if (!denialId) {
        const labels = recent.map(
          (denial) => `${denial.denialId} — ${denial.summary}`,
        );
        const selected = await ctx.ui.select(
          "Auto-review Denials — approve one exact retry",
          labels,
        );
        denialId = selected?.split(" — ", 1)[0] ?? "";
      }
      if (!denialId || !lifecycle.authorizeOneRetry(denialId)) {
        ctx.ui.notify("That denial is no longer available for override.", "warning");
        return;
      }
      logSafeAllow("override.authorized", { denialId, oneShot: true });
      ctx.ui.notify(
        "One exact retry is authorized. The retry will still be reviewed and absolute denies still apply.",
        "info",
      );
    },
  });
}
