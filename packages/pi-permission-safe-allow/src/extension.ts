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

import {
  type LoadConfigResult,
  loadSafeAllowConfig,
  type ReviewerModelSource,
} from "./config-loader";
import {
  SAFE_ALLOW_EXTENSION_ID,
  SAFE_ALLOW_LINK_NAME,
  type SafeAllowConfig,
} from "./config-schema";
import { logSafeAllow } from "./log";
import { DenialLifecycle } from "./denial-lifecycle";
import type { EvaluateJevFn } from "./jev-evaluation";
import type { CompleteFn, ModelRegistryLike } from "./model-review";
import { createSafeAllowReviewer } from "./safe-allow-reviewer";
import { registerReviewerModelSession } from "./reviewer-model-session";

export interface SafeAllowDependencies {
  loadConfig?: (cwd: string) => LoadConfigResult;
  complete?: CompleteFn;
  evaluate?: EvaluateJevFn;
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
  let reviewerModelSource: ReviewerModelSource = "built-in default";
  let projectConfigPath: string | undefined;
  let globalConfigPath: string | undefined;
  let currentContext: ExtensionContext | undefined;
  let dispose: (() => void) | undefined;
  const lifecycle = new DenialLifecycle();
  const retryTimers: ReturnType<typeof setTimeout>[] = [];

  function applyConfigResult(result: LoadConfigResult): void {
    config = result.config;
    reviewerModelSource = result.reviewerModelSource ?? "built-in default";
    projectConfigPath = result.projectConfigPath;
    globalConfigPath = result.globalConfigPath;
  }

  const reviewerModelSession = registerReviewerModelSession(pi, {
    getBaseConfig: () => config,
    getBaseSource: () => reviewerModelSource,
    getRegistry: () => registry,
    getConfigPath: (scope) =>
      scope === "Project" ? projectConfigPath : globalConfigPath,
    refreshBaseConfig: () => {
      if (currentContext) applyConfigResult(loadConfig(currentContext.cwd));
    },
  });

  function clearRetries(): void {
    while (retryTimers.length > 0) {
      const t = retryTimers.pop();
      if (t) clearTimeout(t);
    }
  }

  function tryRegister(source: string, options: { final?: boolean } = {}): boolean {
    const effectiveConfig = reviewerModelSession.effectiveConfig();
    if (!sessionStarted || !effectiveConfig) {
      logSafeAllow("register.skip", {
        source,
        reason: !sessionStarted ? "session_not_started" : "no_config",
      });
      return false;
    }
    if (dispose) {
      // Expected once registration wins a race against retries — file-only.
      logSafeAllow("register.skip", { source, reason: "already_registered" });
      return true;
    }

    const service = getPermissionsService();
    if (!service) {
      // Intermediate misses are normal (load-order races). Only escalate on the
      // final retry so the TUI stays quiet unless registration truly fails.
      if (options.final) {
        logSafeAllow("register.fail", {
          source,
          reason: "permissions_service_missing",
        });
      } else {
        logSafeAllow("register.skip", {
          source,
          reason: "permissions_service_missing",
        });
      }
      return false;
    }

    if (typeof service.registerAuthorizer !== "function") {
      logSafeAllow("register.fail", {
        source,
        reason: "no_registerAuthorizer_api",
      });
      return false;
    }

    const authorize = createSafeAllowReviewer({
      getConfig: () => reviewerModelSession.effectiveConfig(),
      getRegistry: () => registry,
      getEvidence: () => currentContext?.sessionManager.getEntries() ?? [],
      getSignal: () => currentContext?.signal,
      lifecycle,
      complete,
      evaluate: dependencies.evaluate,
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
      dispose = service.registerAuthorizer(SAFE_ALLOW_LINK_NAME, authorize, {
        pathEnvelopeMode: effectiveConfig.pathEnvelopeMode,
      });
      clearRetries();
      logSafeAllow("register.ok", {
        source,
        link: SAFE_ALLOW_LINK_NAME,
        provider: effectiveConfig.provider,
        model: effectiveConfig.model,
        hasRegistry: Boolean(registry),
        modelResolves: Boolean(
          registry?.find(effectiveConfig.provider, effectiveConfig.model),
        ),
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // If already registered by a prior attempt, treat as ok
      if (/already registered/i.test(message)) {
        clearRetries();
        logSafeAllow("register.ok", {
          source,
          link: SAFE_ALLOW_LINK_NAME,
          note: "already_registered_error",
        });
        dispose = () => {
          /* no-op disposer for sticky registration */
        };
        return true;
      }
      logSafeAllow("register.fail", { source, error: message });
      return false;
    }
  }

  function scheduleRetries(source: string): void {
    // Skip when already registered or a retry chain is already in flight —
    // stacking session_start + permissions_ready chains would double-fire
    // the final register.fail console surface.
    if (dispose || retryTimers.length > 0) return;
    const delays = [0, 50, 200, 500, 1500];
    for (let i = 0; i < delays.length; i++) {
      const ms = delays[i]!;
      const final = i === delays.length - 1;
      retryTimers.push(
        setTimeout(() => {
          tryRegister(`${source}+${ms}ms`, { final });
        }, ms),
      );
    }
  }

  pi.on("session_start", (event, ctx) => {
    const result = loadConfig(ctx.cwd);
    applyConfigResult(result);
    registry = ctx.modelRegistry as ModelRegistryLike | undefined;
    currentContext = ctx;
    reviewerModelSession.restore(event, ctx);
    const effectiveConfig = reviewerModelSession.effectiveConfig()!;
    lifecycle.resetSession();
    sessionStarted = true;
    dispose = undefined;
    clearRetries();

    logSafeAllow("session_start", {
      cwd: ctx.cwd,
      provider: effectiveConfig.provider,
      model: effectiveConfig.model,
      hasRegistry: Boolean(registry),
      modelResolves: Boolean(
        registry?.find(effectiveConfig.provider, effectiveConfig.model),
      ),
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

    if (!tryRegister("session_start")) {
      scheduleRetries("session_start");
    }
  });

  pi.events.on(PERMISSIONS_READY_CHANNEL, () => {
    logSafeAllow("permissions_ready", {
      sessionStarted,
      servicePresent: Boolean(getPermissionsService()),
    });
    if (!tryRegister("permissions_ready")) {
      scheduleRetries("permissions_ready");
    }
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
    reviewerModelSession.clear();
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
