const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function ownDescriptors(value: object): PropertyDescriptorMap | null {
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function isJsonData(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }

  const descriptors = ownDescriptors(value);
  if (!descriptors) return false;
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === "length") continue;
      if (!isArrayIndex(key, value.length) || !descriptor.enumerable || !("value" in descriptor)) {
        return false;
      }
      if (!isJsonData(descriptor.value, seen)) return false;
    }
    return true;
  }

  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      DANGEROUS_KEYS.has(key) ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isJsonData(descriptor.value, seen)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Descriptor-safe predicate for an inert JSON-like top-level argument record.
 * It never reads property values through ordinary property access, so accessors
 * are rejected without invoking them.
 */
export function isJsonDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return isJsonData(value, new WeakSet<object>());
}
