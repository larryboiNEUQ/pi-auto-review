import { readFileSync } from "node:fs";

import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ReviewerModelSource } from "./config-loader";
import type { SafeAllowConfig } from "./config-schema";
import type { ModelRegistryLike } from "./model-review";

export const REVIEWER_MODEL_SESSION_ENTRY =
  "pi-permission-safe-allow:reviewer-model";

interface ReviewerModelReference {
  provider: string;
  model: string;
}

interface ReviewerModelSessionState {
  version: 1;
  selection: ReviewerModelReference | null;
}

export interface ReviewerModelSessionController {
  restore(
    event: { reason?: string; previousSessionFile?: string },
    ctx: ExtensionContext,
  ): void;
  clear(): void;
  effectiveConfig(): SafeAllowConfig | undefined;
}

function isReference(value: unknown): value is ReviewerModelReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReviewerModelReference>;
  return (
    typeof candidate.provider === "string" &&
    candidate.provider.length > 0 &&
    typeof candidate.model === "string" &&
    candidate.model.length > 0
  );
}

function stateFromEntry(entry: unknown): ReviewerModelSessionState | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const candidate = entry as {
    type?: unknown;
    customType?: unknown;
    data?: Partial<ReviewerModelSessionState>;
  };
  if (
    candidate.type !== "custom" ||
    candidate.customType !== REVIEWER_MODEL_SESSION_ENTRY ||
    candidate.data?.version !== 1
  ) {
    return undefined;
  }
  if (candidate.data.selection === null || isReference(candidate.data.selection)) {
    return candidate.data as ReviewerModelSessionState;
  }
  return undefined;
}

function latestState(entries: readonly unknown[]): ReviewerModelSessionState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const state = stateFromEntry(entries[index]);
    if (state) return state;
  }
  return undefined;
}

function inheritedForkState(path: string | undefined): ReviewerModelSessionState | undefined {
  if (!path) return undefined;
  try {
    const entries = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    return latestState(entries);
  } catch {
    return undefined;
  }
}

function parseReference(input: string): ReviewerModelReference | undefined {
  if (!input || /\s/.test(input)) return undefined;
  const separator = input.indexOf("/");
  if (separator <= 0 || separator === input.length - 1) return undefined;
  return { provider: input.slice(0, separator), model: input.slice(separator + 1) };
}

function modelKey(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

type ModelScopeContext = ExtensionContext & {
  scopedModels?: ReadonlyArray<{ model: Model<any> }>;
};

function availableModels(
  ctx: ModelScopeContext,
  registry: ModelRegistryLike,
): readonly Model<any>[] {
  if (ctx.scopedModels && ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map((entry) => entry.model);
  }
  return registry.getAvailable?.() ?? [];
}

async function validationError(
  reference: ReviewerModelReference,
  ctx: ModelScopeContext,
  registry: ModelRegistryLike | undefined,
): Promise<string | undefined> {
  if (!registry) return "the Pi model registry is unavailable";
  const model = registry.find(reference.provider, reference.model);
  if (!model) return "the reviewer model does not exist";
  const allowed = availableModels(ctx, registry).some(
    (candidate) => modelKey(candidate) === `${reference.provider}/${reference.model}`,
  );
  if (!allowed) return "the reviewer model is outside the current Pi model scope";
  if (!registry.getApiKeyAndHeaders) {
    return "reviewer authentication cannot be resolved";
  }
  try {
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) return "reviewer authentication is unavailable";
  } catch {
    return "reviewer authentication validation failed";
  }
  return undefined;
}

export function registerReviewerModelSession(
  pi: ExtensionAPI,
  dependencies: {
    getBaseConfig: () => SafeAllowConfig | undefined;
    getBaseSource: () => ReviewerModelSource;
    getRegistry: () => ModelRegistryLike | undefined;
  },
): ReviewerModelSessionController {
  let selection: ReviewerModelReference | undefined;

  const controller: ReviewerModelSessionController = {
    restore(event, ctx) {
      const branch = ctx.sessionManager.getBranch();
      let state = latestState(branch);
      if (!state && event.reason === "fork") {
        state = inheritedForkState(event.previousSessionFile);
        if (state?.selection) {
          pi.appendEntry(REVIEWER_MODEL_SESSION_ENTRY, state);
        }
      }
      selection = state?.selection ?? undefined;
    },
    clear() {
      selection = undefined;
    },
    effectiveConfig() {
      const base = dependencies.getBaseConfig();
      return base && selection
        ? { ...base, provider: selection.provider, model: selection.model }
        : base;
    },
  };

  pi.registerCommand("review-model", {
    description: "Inspect or switch the Session-scoped safe-allow reviewer model",
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      const registry = dependencies.getRegistry();
      const effective = controller.effectiveConfig();
      if (!effective) {
        ctx.ui.notify("Safe-allow reviewer configuration is unavailable.", "error");
        return;
      }

      if (args === "show") {
        const error = await validationError(
          { provider: effective.provider, model: effective.model },
          ctx,
          registry,
        );
        const source = selection ? "Session" : dependencies.getBaseSource();
        ctx.ui.notify(
          `Safe-allow reviewer model: ${effective.provider}/${effective.model}; source: ${source}; validation: ${error ? `invalid (${error})` : "valid"}. This is independent from Pi's /model.`,
          error ? "warning" : "info",
        );
        return;
      }

      if (args === "reset") {
        if (selection) {
          try {
            pi.appendEntry(REVIEWER_MODEL_SESSION_ENTRY, {
              version: 1,
              selection: null,
            } satisfies ReviewerModelSessionState);
          } catch {
            ctx.ui.notify(
              "Could not persist the reviewer model reset; the Session selection is unchanged.",
              "error",
            );
            return;
          }
          selection = undefined;
        }
        const fallback = controller.effectiveConfig()!;
        ctx.ui.notify(
          `Session reviewer model reset to ${fallback.provider}/${fallback.model} (${dependencies.getBaseSource()}).`,
          "info",
        );
        return;
      }

      let reference: ReviewerModelReference | undefined;
      if (!args) {
        if (!registry) {
          ctx.ui.notify("The Pi model registry is unavailable.", "error");
          return;
        }
        const models = availableModels(ctx, registry).slice().sort((a, b) =>
          modelKey(a).localeCompare(modelKey(b)),
        );
        if (models.length === 0) {
          ctx.ui.notify("No reviewer models are available in the current Pi model scope.", "warning");
          return;
        }
        const currentKey = `${effective.provider}/${effective.model}`;
        const labels = models.map((model) => {
          const key = modelKey(model);
          return `${key}${key === currentKey ? " (current reviewer)" : ""}`;
        });
        const chosen = await ctx.ui.select(
          "Safe-allow reviewer model (independent from Pi /model)",
          labels,
        );
        if (!chosen) return;
        const index = labels.indexOf(chosen);
        const model = index >= 0 ? models[index] : undefined;
        if (model) reference = { provider: model.provider, model: model.id };
      } else {
        reference = parseReference(args);
      }

      if (!reference) {
        ctx.ui.notify(
          "Malformed reviewer model reference. Use provider/model (model IDs may contain slashes).",
          "error",
        );
        return;
      }
      const error = await validationError(reference, ctx, registry);
      if (error) {
        ctx.ui.notify(`Reviewer model switch failed: ${error}.`, "error");
        return;
      }

      try {
        pi.appendEntry(REVIEWER_MODEL_SESSION_ENTRY, {
          version: 1,
          selection: reference,
        } satisfies ReviewerModelSessionState);
      } catch {
        ctx.ui.notify(
          "Could not persist the reviewer model selection; the active reviewer is unchanged.",
          "error",
        );
        return;
      }
      selection = reference;
      ctx.ui.notify(
        `Session reviewer model switched to ${reference.provider}/${reference.model}. Pi's main model is unchanged.`,
        "info",
      );
    },
  });

  return controller;
}
