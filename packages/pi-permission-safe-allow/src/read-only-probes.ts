import {
  type DelegatedApprovalFacts,
  isJsonDataRecord,
  type PermissionQuery,
  type PromptPermissionDetails,
  withResolvedDelegatedApprovalTarget,
} from "@gotgenes/pi-permission-system";

import { MAX_PROBE_TIMEOUT_MS } from "./config-schema";
import { redactSecrets } from "./redaction";

export interface ProbeEvidence {
  category: "probe";
  provenance: "permission-system canonical target resolution";
  capability: "permission.target.resolve";
  untrusted: true;
  secretSafe: true;
  result: {
    surface: "mcp";
    value: string;
    target: string;
  };
}

export type ProbeOutcome =
  | {
      kind: "completed";
      facts: DelegatedApprovalFacts;
      evidence: ProbeEvidence[];
      hops: number;
      durationMs: number;
    }
  | {
      kind: "ineligible" | "failure";
      code: "ineligible" | "budget" | "timeout" | "probe";
      message: string;
      hops: number;
      durationMs: number;
    };

type ProbeResolutionResult = ReturnType<PermissionQuery["resolveTarget"]>;
type BoundedLookup =
  | { kind: "result"; result: ProbeResolutionResult }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: unknown };

function boundedProbeTimeoutMs(timeoutMs: number): number {
  return Math.min(
    MAX_PROBE_TIMEOUT_MS,
    Math.max(1, Math.floor(timeoutMs)),
  );
}

function runBoundedLookup(inputs: {
  query: PermissionQuery;
  value: string;
  agentName?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<BoundedLookup> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: BoundedLookup) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inputs.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ kind: "cancelled" });
    const timer = setTimeout(
      () => finish({ kind: "timeout" }),
      boundedProbeTimeoutMs(inputs.timeoutMs),
    );
    inputs.signal?.addEventListener("abort", onAbort, { once: true });

    queueMicrotask(() => {
      if (settled) return;
      Promise.resolve()
        .then(() => inputs.query.resolveTarget("mcp", inputs.value, inputs.agentName))
        .then(
        (result) => finish({ kind: "result", result }),
        (error: unknown) => finish({ kind: "error", error }),
      );
    });
  });
}

function isEligibleTargetProbe(facts: DelegatedApprovalFacts): boolean {
  return facts.policy.state === "ask" &&
    !facts.complete &&
    facts.missing.length === 1 &&
    facts.missing[0] === "action.target" &&
    facts.surface === "mcp" &&
    facts.action.kind === "mcp" &&
    Boolean(facts.value) &&
    Boolean(facts.action.mcp?.server) &&
    Boolean(facts.action.mcp?.tool) &&
    isJsonDataRecord(facts.action.mcp?.annotations) &&
    facts.action.mcp.annotations.readOnlyHint === true &&
    isJsonDataRecord(facts.action.mcp.arguments) &&
    facts.redactions.length === 0;
}

/**
 * Runs the fixed read-only probe allowlist. This is a bounded metadata lookup,
 * not a tool-capable Guardian agent and not an OS containment boundary.
 */
export async function runReadOnlyProbes(inputs: {
  details: PromptPermissionDetails;
  query: PermissionQuery;
  maxHops: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProbeOutcome> {
  const started = Date.now();
  const facts = inputs.details.delegatedApproval;
  if (!facts || !isEligibleTargetProbe(facts)) {
    return {
      kind: "ineligible",
      code: "ineligible",
      message: "The incomplete dossier is not eligible for a read-only probe.",
      hops: 0,
      durationMs: Date.now() - started,
    };
  }
  if (!Number.isFinite(inputs.maxHops) || inputs.maxHops <= 0) {
    return {
      kind: "failure",
      code: "budget",
      message: "The read-only probe hop budget was exhausted.",
      hops: 0,
      durationMs: Date.now() - started,
    };
  }
  if (inputs.signal?.aborted) {
    return {
      kind: "failure",
      code: "probe",
      message: "The read-only probe was cancelled.",
      hops: 0,
      durationMs: Date.now() - started,
    };
  }

  const mcp = facts.action.mcp!;
  const lookupValue = `${mcp.server}:${mcp.tool}`;
  const lookup = await runBoundedLookup({
    query: inputs.query,
    value: lookupValue,
    agentName: inputs.details.agentName ?? undefined,
    timeoutMs: inputs.timeoutMs,
    signal: inputs.signal,
  });
  const durationMs = Date.now() - started;
  if (lookup.kind === "timeout") {
    return {
      kind: "failure",
      code: "timeout",
      message: "The read-only probe timed out.",
      hops: 1,
      durationMs,
    };
  }
  if (lookup.kind === "cancelled") {
    return {
      kind: "failure",
      code: "probe",
      message: "The read-only probe was cancelled.",
      hops: 1,
      durationMs,
    };
  }
  if (lookup.kind === "error") {
    return {
      kind: "failure",
      code: "probe",
      message: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
      hops: 1,
      durationMs,
    };
  }
  const target = lookup.result;
  if (typeof target !== "string" || !target.trim()) {
    return {
      kind: "failure",
      code: "probe",
      message: "The read-only probe did not resolve the missing target.",
      hops: 1,
      durationMs,
    };
  }
  const secretSafeTarget = String(redactSecrets(target));
  if (secretSafeTarget !== target) {
    return {
      kind: "failure",
      code: "probe",
      message: "The canonical target was rejected because it was not secret-safe.",
      hops: 1,
      durationMs,
    };
  }
  const completedFacts = withResolvedDelegatedApprovalTarget(facts, target);
  return {
    kind: "completed",
    facts: completedFacts,
    evidence: [{
      category: "probe",
      provenance: "permission-system canonical target resolution",
      capability: "permission.target.resolve",
      untrusted: true,
      secretSafe: true,
      result: {
        surface: "mcp",
        value: String(redactSecrets(lookupValue)),
        target,
      },
    }],
    hops: 1,
    durationMs,
  };
}
