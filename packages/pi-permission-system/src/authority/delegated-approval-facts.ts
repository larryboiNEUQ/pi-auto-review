import { createHash } from "node:crypto";

import type { PermissionCheckResult } from "#src/types";
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

function sanitize(value: unknown, path: string, redactions: string[]): unknown {
  if (typeof value === "string") {
    const sanitized = value.replace(SECRET_VALUE, "[REDACTED_SECRET]");
    if (sanitized !== value) redactions.push(path);
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitize(entry, `${path}[${index}]`, redactions),
    );
  }
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryPath = `${path}.${key}`;
    if (SECRET_KEY.test(key)) {
      result[key] = "[REDACTED_SECRET]";
      redactions.push(entryPath);
    } else {
      result[key] = sanitize(entry, entryPath, redactions);
    }
  }
  return result;
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
  const safeInput = sanitize(inputs.input, "action.input", redactions);
  const inputRecord = asRecord(safeInput);
  const missing: string[] = [];
  if (!surface) missing.push("surface");
  if (!value) missing.push("value");
  const kind = actionKind(surface, details);
  const action = {
    kind,
    toolName: details.toolName ?? null,
    command: details.command ?? check.command ?? null,
    path: details.path ?? null,
    target: details.target ?? check.target ?? null,
    input: safeInput,
    mcp:
      kind === "mcp"
        ? {
            server: firstString(inputRecord, ["server", "serverName", "mcpServer"]),
            tool: firstString(inputRecord, ["tool", "toolName", "name"]),
            annotations: inputRecord.annotations ?? null,
            connectedAccount:
              inputRecord.connectedAccount ?? inputRecord.account ?? null,
            arguments: inputRecord.arguments ?? inputRecord.input ?? safeInput,
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
  if (kind === "shell" && hasUnknownRuntimePayload(action.command)) {
    missing.push("runtime_payload");
  }

  return {
    version: 1,
    requestId: details.requestId,
    surface,
    value,
    action,
    cwd: details.cwd ?? null,
    accessIntent: details.accessIntent ?? null,
    policy: {
      state: check.state,
      source: check.source,
      origin: check.origin,
      matchedPattern: check.matchedPattern ?? null,
      reason: check.reason ?? null,
    },
    permissionDelta: { from: "ask", to: "allow_once", surface, value },
    redactions: [...new Set(redactions)],
    complete: missing.length === 0,
    missing,
    exactActionId: createHash("sha256")
      .update(stableStringify({ surface, value, action }))
      .digest("hex"),
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
