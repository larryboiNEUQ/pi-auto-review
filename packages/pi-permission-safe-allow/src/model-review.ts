/**
 * Call a light model to judge an external_directory ask.
 * Fail-safe: any error / timeout / bad JSON → defer.
 *
 * Critical: openai-codex (and most pi providers) need apiKey/headers from
 * ModelRegistry.getApiKeyAndHeaders(model). Bare complete() without auth
 * returns empty content in a few ms — which we used to treat as defer.
 */

import type {
  AssistantMessage,
  Context,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { AuthorizerVerdict } from "@gotgenes/pi-permission-system";

import type { SafeAllowConfig } from "./config-schema";
import { logSafeAllow } from "./log";

export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    signal?: AbortSignal;
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  },
) => Promise<AssistantMessage>;

export type ResolvedRequestAuth =
  | {
      ok: true;
      apiKey?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    }
  | {
      ok: false;
      error: string;
    };

export interface ModelRegistryLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getApiKeyAndHeaders?(model: Model<any>): Promise<ResolvedRequestAuth>;
}

export interface ReviewExternalPathInputs {
  path: string;
  toolName?: string;
  message?: string;
  config: SafeAllowConfig;
  model: Model<any>;
  registry: ModelRegistryLike;
  complete: CompleteFn;
}

export async function reviewExternalPath(
  inputs: ReviewExternalPathInputs,
): Promise<AuthorizerVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, inputs.config.timeoutMs);

  try {
    let apiKey: string | undefined;
    let headers: Record<string, string> | undefined;
    let env: Record<string, string> | undefined;

    if (typeof inputs.registry.getApiKeyAndHeaders === "function") {
      const auth = await inputs.registry.getApiKeyAndHeaders(inputs.model);
      if (!auth.ok) {
        logSafeAllow("model.auth_fail", {
          path: inputs.path,
          error: auth.error,
        });
        return { kind: "defer" };
      }
      apiKey = auth.apiKey;
      headers = auth.headers;
      env = auth.env;
      logSafeAllow("model.auth_ok", {
        path: inputs.path,
        hasApiKey: Boolean(apiKey),
        headerKeys: headers ? Object.keys(headers) : [],
      });
    } else {
      logSafeAllow("model.auth_skip", {
        path: inputs.path,
        reason: "registry_missing_getApiKeyAndHeaders",
      });
    }

    const context: Context = {
      systemPrompt: inputs.config.instructions,
      messages: [
        {
          role: "user",
          content: renderPrompt(inputs),
          timestamp: Date.now(),
        },
      ],
    };

    const reply = await inputs.complete(inputs.model, context, {
      signal: controller.signal,
      apiKey,
      headers,
      env,
    });

    const raw = extractText(reply);
    const stopReason =
      reply && typeof reply === "object" && "stopReason" in reply
        ? String((reply as { stopReason?: unknown }).stopReason ?? "")
        : "";
    const errorMessage =
      reply && typeof reply === "object" && "errorMessage" in reply
        ? String((reply as { errorMessage?: unknown }).errorMessage ?? "")
        : "";

    if (stopReason === "error" || stopReason === "aborted") {
      logSafeAllow("model.error_stop", {
        path: inputs.path,
        stopReason,
        errorMessage,
        raw: raw.slice(0, 500),
      });
      return { kind: "defer" };
    }

    const verdict = parseVerdict(raw);
    logSafeAllow("model.raw_reply", {
      path: inputs.path,
      raw: raw.slice(0, 500),
      stopReason,
      errorMessage: errorMessage || null,
      verdict: verdict.kind,
      contentLen: Array.isArray(reply?.content) ? reply.content.length : -1,
    });
    return verdict;
  } catch (error) {
    logSafeAllow("model.error", {
      path: inputs.path,
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : typeof error,
    });
    return { kind: "defer" };
  } finally {
    clearTimeout(timer);
  }
}

function renderPrompt(inputs: ReviewExternalPathInputs): string {
  const lines = [
    "A tool wants outside-working-directory access.",
    "",
    `path: ${inputs.path}`,
  ];
  if (inputs.toolName) {
    lines.push(`tool: ${inputs.toolName}`);
  }
  if (inputs.message) {
    lines.push(`prompt: ${inputs.message}`);
  }
  lines.push(
    "",
    "This is a normal local-dev path review.",
    "If the path is clearly a non-secret code/docs/cache path (e.g. under Downloads, a package README, source files), verdict MUST be allow.",
    "If secrets/keys/credentials or destructive system paths, deny.",
    "Only defer when truly unclear.",
    "",
    'Reply JSON only: {"verdict":"allow"} | {"verdict":"deny","reason":"..."} | {"verdict":"defer"}',
  );
  return lines.join("\n");
}

function parseVerdict(textIn: string): AuthorizerVerdict {
  const text = textIn.trim();
  if (!text) {
    return { kind: "defer" };
  }
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (!match) {
      return { kind: "defer" };
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { kind: "defer" };
    }
  }

  if (!isRecord(parsed) || typeof parsed.verdict !== "string") {
    return { kind: "defer" };
  }

  const verdict = parsed.verdict.toLowerCase();
  if (verdict === "allow") {
    return { kind: "allow" };
  }
  if (verdict === "deny") {
    const reason =
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "Blocked by safe-allow model review.";
    return { kind: "deny", reason };
  }
  return { kind: "defer" };
}

function extractText(reply: AssistantMessage): string {
  if (!reply || !Array.isArray(reply.content)) {
    return "";
  }
  return reply.content
    .filter((part): part is TextContent => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
