const SECRET_KEY =
  /(^|[_-])(api[_-]?key|authorization|cookie|credential|passwd|password|private[_-]?key|secret|session[_-]?token|token)($|[_-])/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+\S+)\b/g;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "[REDACTED_SECRET]");
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_KEY.test(key) ? "[REDACTED_SECRET]" : redactSecrets(entry);
  }
  return result;
}

export function secretSafeJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value));
}
