/** Extension id — config lives at extensions/<id>/config.json. */
export const SAFE_ALLOW_EXTENSION_ID = "pi-permission-safe-allow";

/** Operator-facing chain-link name referenced from authorizerChain. */
export const SAFE_ALLOW_LINK_NAME = "safe-allow";

export const DEFAULT_TIMEOUT_MS = 5000;

export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.4-mini";

export const DEFAULT_INSTRUCTIONS = [
  "You are a permission judge for outside-working-directory filesystem access.",
  "The rule engine already marked this as ask. You may allow, deny, or defer.",
  "",
  "Default bias for local development: ALLOW ordinary non-secret paths.",
  "ALLOW examples:",
  "- README.md / source / docs under Downloads, sibling repos, package checkouts",
  "- tool caches, temp dirs, language runtimes, build artifacts",
  "- reading config files that are not credentials",
  "",
  "DENY examples:",
  "- .env, private keys, auth tokens, password stores, ssh/aws secrets",
  "- clearly destructive system paths",
  "",
  "DEFER only when truly unclear. Do not defer ordinary README/source reads.",
  "",
  "Reply with strict JSON only, no markdown fence:",
  '{"verdict":"allow"}',
  'or {"verdict":"deny","reason":"<short teaching reason>"}',
  'or {"verdict":"defer"}',
].join("\n");

export interface SafeAllowConfig {
  provider: string;
  model: string;
  instructions: string;
  timeoutMs: number;
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
    disabled: partial?.disabled === true,
  };
}
