import { createHash } from "node:crypto";

import type { PermissionCheckResult } from "#src/types";
import { isJsonDataRecord } from "#src/json-data";
import type { ForwardedAccessFacts } from "./permission-forwarding";
import type { PromptPermissionDetails } from "./permission-prompter";

export type DelegatedActionKind =
  | "shell"
  | "file"
  | "external_path"
  | "network"
  | "mcp"
  | "permission"
  | "skill"
  | "special";

export interface DelegatedApprovalFacts {
  version: 1;
  requestId: string;
  surface: string;
  value: string;
  action: {
    kind: DelegatedActionKind;
    toolName: string | null;
    command: string | null;
    path: string | null;
    target: string | null;
    input: unknown;
    mcp: {
      server: string | null;
      tool: string | null;
      annotations: unknown;
      connectedAccount: unknown;
      arguments: unknown;
    } | null;
    authentication: {
      credentialPresent: boolean;
      valuesIncluded: false;
      mechanism: string | null;
    };
  };
  cwd: string | null;
  accessIntent: ForwardedAccessFacts | null;
  policy: {
    state: PermissionCheckResult["state"];
    source: PermissionCheckResult["source"];
    origin: PermissionCheckResult["origin"];
    matchedPattern: string | null;
    reason: string | null;
  };
  permissionDelta: {
    from: "ask";
    to: "allow_once";
    surface: string;
    value: string;
  };
  redactions: string[];
  complete: boolean;
  missing: string[];
  exactActionId: string;
}

const SECRET_KEY =
  /(^|[_-])(api[_-]?key|authorization|cookie|credential|passwd|password|private[_-]?key|secret|session[_-]?token|token)($|[_-])/i;
const SECRET_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+\S+)\b/g;
const SECRET_ASSIGNMENT =
  /(\b(?:api[_-]?key|password|secret|token)=)([^\s]+)/gi;
const SECRET_FLAG =
  /((?:--?(?:api[-_]?key|password|secret|token))\s+)([^\s]+)/gi;

function sanitize(value: unknown, path: string, redactions: string[]): unknown {
  if (typeof value === "string") {
    const sanitized = value
      .replace(SECRET_VALUE, "[REDACTED_SECRET]")
      .replace(SECRET_ASSIGNMENT, "$1[REDACTED_SECRET]")
      .replace(SECRET_FLAG, "$1[REDACTED_SECRET]");
    if (sanitized !== value) redactions.push(path);
    return sanitized;
  }
  if (typeof value !== "object" || value === null) return value;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return Array.isArray(value) ? [] : {};
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      result.push(descriptor && "value" in descriptor
        ? sanitize(descriptor.value, `${path}[${index}]`, redactions)
        : null);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) continue;
    const entryPath = `${path}.${key}`;
    if (SECRET_KEY.test(key)) {
      result[key] = "[REDACTED_SECRET]";
      redactions.push(entryPath);
    } else {
      result[key] = sanitize(descriptor.value, entryPath, redactions);
    }
  }
  return result;
}

/** Shared secret redaction contract used by dossier construction and reviewers. */
export function redactApprovalSecrets(value: unknown): unknown {
  return sanitize(value, "$", []);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type ExactActionIdentity = Pick<
  DelegatedApprovalFacts,
  "surface" | "value" | "action" | "cwd" | "accessIntent"
>;

function computeExactActionId(identity: ExactActionIdentity): string {
  return createHash("sha256")
    .update(stableStringify(identity))
    .digest("hex");
}

function actionKind(
  surface: string,
  details: PromptPermissionDetails,
): DelegatedActionKind {
  if (surface === "bash" || details.command) return "shell";
  if (surface === "external_directory") return "external_path";
  if (surface === "mcp" || details.toolName === "mcp") return "mcp";
  if (surface === "network") return "network";
  if (surface === "request_permissions" || surface === "permission") return "permission";
  if (surface === "skill" || details.skillName) return "skill";
  if (["read", "write", "edit", "patch", "path"].includes(surface)) return "file";
  return "special";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  return null;
}

function hasKnownMcpArguments(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, "arguments");
  } catch {
    return false;
  }
  return Boolean(descriptor && "value" in descriptor && isJsonDataRecord(descriptor.value));
}

function hasUnknownRuntimePayload(command: string | null): boolean {
  if (!command) return false;
  return /\beval\s+["']?\$[{A-Za-z_]/.test(command) ||
    /\b(?:ba|z|k)?sh\s+-c\s+["']\$[{A-Za-z_]/.test(command);
}

export function buildDelegatedApprovalFacts(inputs: {
  details: PromptPermissionDetails;
  input: unknown;
  check: PermissionCheckResult;
  surface: string;
  value: string;
}): DelegatedApprovalFacts {
  const { details, check, surface, value } = inputs;
  const redactions: string[] = [];
  const inputIsKnown = isJsonDataRecord(inputs.input);
  const safeInput = inputIsKnown
    ? sanitize(inputs.input, "action.input", redactions)
    : {};
  const safeValue = sanitize(value, "value", redactions) as string;
  const safeAccessIntent = sanitize(
    details.accessIntent ?? null,
    "accessIntent",
    redactions,
  ) as ForwardedAccessFacts | null;
  const safeCwd = sanitize(details.cwd ?? null, "cwd", redactions) as
    | string
    | null;
  const inputRecord = asRecord(safeInput);
  const missing: string[] = [];
  if (!inputIsKnown) missing.push("action.input");
  if (!surface) missing.push("surface");
  if (!safeValue) missing.push("value");
  const kind = actionKind(surface, details);
  const action = {
    kind,
    toolName: sanitize(
      details.toolName ?? null,
      "action.toolName",
      redactions,
    ) as string | null,
    command: sanitize(
      details.command ?? check.command ?? null,
      "action.command",
      redactions,
    ) as string | null,
    path: sanitize(details.path ?? null, "action.path", redactions) as string | null,
    target: sanitize(
      details.target ?? check.target ?? null,
      "action.target",
      redactions,
    ) as string | null,
    input: safeInput,
    mcp:
      kind === "mcp"
        ? {
            server: firstString(inputRecord, ["server", "serverName", "mcpServer"]),
            tool: firstString(inputRecord, ["tool", "toolName", "name"]),
            annotations: inputRecord.annotations ?? null,
            connectedAccount:
              inputRecord.connectedAccount ?? inputRecord.account ?? null,
            arguments: Object.hasOwn(inputRecord, "arguments")
              ? inputRecord.arguments
              : null,
          }
        : null,
    authentication: {
      credentialPresent: redactions.length > 0,
      valuesIncluded: false as const,
      mechanism:
        firstString(asRecord(inputRecord.auth), ["type", "mechanism", "provider"]) ??
        firstString(inputRecord, ["authMechanism"]),
    },
  };
  if (
    kind === "mcp" &&
    (action.target === "mcp" || action.target === "mcp_call") &&
    action.mcp?.server &&
    action.mcp.tool
  ) {
    // These are policy fallback categories, not the exact invoked MCP target.
    action.target = null;
  }
  if (kind === "mcp" && !action.target) {
    missing.push("action.target");
  }
  if (kind === "mcp" && !hasKnownMcpArguments(inputs.input)) {
    missing.push("action.mcp.arguments");
  }
  if (kind === "shell" && hasUnknownRuntimePayload(action.command)) {
    missing.push("runtime_payload");
  }

  return {
    version: 1,
    requestId: details.requestId,
    surface,
    value: safeValue,
    action,
    cwd: safeCwd,
    accessIntent: safeAccessIntent,
    policy: {
      state: check.state,
      source: check.source,
      origin: check.origin,
      matchedPattern: sanitize(
        check.matchedPattern ?? null,
        "policy.matchedPattern",
        redactions,
      ) as string | null,
      reason: sanitize(check.reason ?? null, "policy.reason", redactions) as
        | string
        | null,
    },
    permissionDelta: {
      from: "ask",
      to: "allow_once",
      surface,
      value: safeValue,
    },
    redactions: [...new Set(redactions)],
    complete: missing.length === 0,
    missing,
    exactActionId: computeExactActionId({
      surface,
      value: safeValue,
      action,
      cwd: safeCwd,
      accessIntent: safeAccessIntent,
    }),
  };
}

/** Completes canonical target enrichment while preserving exact-action identity. */
export function withResolvedDelegatedApprovalTarget(
  facts: DelegatedApprovalFacts,
  target: string,
): DelegatedApprovalFacts {
  const action = { ...facts.action, target };
  return {
    ...facts,
    action,
    complete: true,
    missing: facts.missing.filter((entry) => entry !== "action.target"),
    exactActionId: computeExactActionId({
      surface: facts.surface,
      value: facts.value,
      action,
      cwd: facts.cwd,
      accessIntent: facts.accessIntent,
    }),
  };
}

export function isDelegatedApprovalFacts(value: unknown): value is DelegatedApprovalFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const facts = value as Partial<DelegatedApprovalFacts>;
  return facts.version === 1 && typeof facts.requestId === "string" &&
    typeof facts.surface === "string" && typeof facts.value === "string" &&
    typeof facts.exactActionId === "string" && typeof facts.action === "object" &&
    facts.action !== null && typeof facts.policy === "object" && facts.policy !== null &&
    !containsUnredactedSecret(facts);
}

function containsUnredactedSecret(value: unknown): boolean {
  if (typeof value === "string") {
    SECRET_VALUE.lastIndex = 0;
    return SECRET_VALUE.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnredactedSecret);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
    if (SECRET_KEY.test(key)) return entry !== "[REDACTED_SECRET]";
    return containsUnredactedSecret(entry);
  });
}
