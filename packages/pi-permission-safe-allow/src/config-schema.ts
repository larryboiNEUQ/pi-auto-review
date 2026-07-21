/** Extension id — config lives at extensions/<id>/config.json. */
export const SAFE_ALLOW_EXTENSION_ID = "pi-permission-safe-allow";

/** Operator-facing chain-link name referenced from authorizerChain. */
export const SAFE_ALLOW_LINK_NAME = "safe-allow";

export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.4-mini";

export const DEFAULT_INSTRUCTIONS = [
  "You are an independent delegated approval reviewer for one exact Pi action.",
  "The deterministic permission engine already marked this action as ask.",
  "Assess intrinsic risk and semantic user authorization from the secret-safe dossier.",
  "Low and medium risk may be allowed. High risk requires at least medium authorization and narrow scope. Critical risk denies.",
  "Deny credential disclosure, untrusted private-data transfer, persistent security weakening, broad irreversible destruction, and absolute policy violations.",
  "A service-native authentication fact is not itself credential disclosure.",
  "An exact prior user override is evidence of authorization, not permission to ignore an absolute deny.",
  "Unknown runtime payloads or missing exact facts deny because the proposed action is not inspectable.",
  "This system has no OS sandbox; never claim sandbox containment or security equivalence with Codex.",
  "",
  "Reply with strict JSON only, no markdown fence:",
  '{"riskLevel":"low|medium|high|critical","userAuthorization":"unknown|low|medium|high","verdict":"allow|deny","rationale":"short reason","scope":"narrow|broad","absoluteDeny":false}',
].join("\n");

export interface SafeAllowConfig {
  provider: string;
  model: string;
  instructions: string;
  timeoutMs: number;
  maxAttempts: number;
  /** When true, skip model and always defer (kill switch). */
  disabled?: boolean;
}

export function withDefaults(
  partial: Partial<SafeAllowConfig> | undefined,
): SafeAllowConfig {
  return {
    provider: partial?.provider?.trim() || DEFAULT_PROVIDER,
    model: partial?.model?.trim() || DEFAULT_MODEL,
    instructions: partial?.instructions?.trim() || DEFAULT_INSTRUCTIONS,
    timeoutMs:
      typeof partial?.timeoutMs === "number" && partial.timeoutMs > 0
        ? Math.floor(partial.timeoutMs)
        : DEFAULT_TIMEOUT_MS,
    maxAttempts:
      typeof partial?.maxAttempts === "number" && partial.maxAttempts > 0
        ? Math.min(3, Math.floor(partial.maxAttempts))
        : DEFAULT_MAX_ATTEMPTS,
    disabled: partial?.disabled === true,
  };
}
