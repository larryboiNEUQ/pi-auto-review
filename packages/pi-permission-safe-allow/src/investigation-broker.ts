import { isProxy } from "node:util/types";
import type { DelegatedApprovalFacts, PermissionQuery } from "@gotgenes/pi-permission-system";
import { redactSecrets } from "./redaction";

export type FactRequest =
  | { tool: "file.metadata" | "file.text"; path: string }
  | { tool: "repository.metadata" };
export type FactFailureCode = "invalid-request" | "ineligible" | "missing-query" | "denied" | "cancelled" | "deadline" | "timeout" | "probe";
export type ProbeEvidence = {
  category: "investigation";
  requestId: string;
  exactActionId: string;
  capability: "file.metadata" | "file.text" | "repository.metadata";
  requestedPath: string;
  canonicalPath: string;
  provenance: "permission-system permitted local fact";
  secretSafe: true;
  untrusted: true;
  result: unknown;
};
const SECRET_NAME = /(?:secret|credential|password|passwd|token|cookie|oauth|auth|private[-_]?key|keychain|id_rsa|id_ed25519|\.pem|\.key|\.p12|\.pfx)/i;
const MAX_RESULT = 4096;

function dataRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => "value" in d);
  } catch { return false; }
}
export function parseFactRequest(input: unknown): FactRequest | undefined {
  if (!dataRecord(input)) return;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Object.keys(descriptors);
  const tool: unknown = descriptors.tool?.value;
  const path: unknown = descriptors.path?.value;
  if (tool === "repository.metadata" && keys.length === 1 && keys[0] === "tool") return { tool };
  if ((tool === "file.metadata" || tool === "file.text") && keys.length === 2 && keys.includes("tool") && keys.includes("path") && typeof path === "string" && path.length > 0 && !(path.split(/[\\/]/).pop() ?? "").startsWith(".") && !SECRET_NAME.test(path.split(/[\\/]/).pop() ?? "")) return { tool, path };
  return;
}
function allowedPath(facts: DelegatedApprovalFacts, path: string): boolean {
  if (facts.action.path === path) return true;
  const action = facts.action;
  const literal = action.input;
  if (dataRecord(literal) && Object.getOwnPropertyDescriptor(literal, "path")?.value === path) return true;
  const args = action.mcp?.arguments;
  return dataRecord(args) && Object.getOwnPropertyDescriptor(args, "path")?.value === path;
}
function safe(value: unknown): unknown | undefined {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return; }
  if (!encoded || encoded.length > MAX_RESULT) return;
  const cleaned = redactSecrets(encoded);
  if (cleaned !== encoded) return;
  try { return JSON.parse(cleaned); } catch { return; }
}
export async function requestFact(inputs: {
  request: unknown; facts: DelegatedApprovalFacts; query?: PermissionQuery; agentName?: string;
  deadline: number; timeoutMs: number; signal?: AbortSignal;
}): Promise<{ kind: "completed"; evidence: ProbeEvidence } | { kind: "failure"; code: FactFailureCode }> {
  const req = parseFactRequest(inputs.request);
  if (!req) return { kind: "failure", code: "invalid-request" };
  if (!inputs.query?.readPermittedLocalFact) return { kind: "failure", code: "missing-query" };
  if (inputs.signal?.aborted) return { kind: "failure", code: "cancelled" };
  if (!Number.isFinite(inputs.deadline) || inputs.deadline <= Date.now()) return { kind: "failure", code: "deadline" };
  const path = req.tool === "repository.metadata" ? "package.json" : req.path;
  if (req.tool !== "repository.metadata" && !allowedPath(inputs.facts, path)) return { kind: "failure", code: "ineligible" };
  const kind = req.tool === "file.metadata" ? "metadata" : "text";
  const timeout = Math.max(1, Math.min(250, Number.isFinite(inputs.timeoutMs) ? inputs.timeoutMs : 1, inputs.deadline - Date.now()));
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void = () => {};
  const bounded = new Promise<"timeout" | "cancelled">(resolve => {
    timer = setTimeout(() => resolve("timeout"), timeout);
    abort = () => resolve("cancelled");
    inputs.signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([inputs.query.readPermittedLocalFact!({ kind, path }, inputs.agentName), bounded]);
    if (result === "timeout") return { kind: "failure", code: Date.now() >= inputs.deadline ? "deadline" : "timeout" };
    if (result === "cancelled") return { kind: "failure", code: "cancelled" };
    if (!result.ok) return { kind: "failure", code: "denied" };
    if (typeof result.canonicalPath !== "string" || !result.canonicalPath) return { kind: "failure", code: "denied" };
    let payload: unknown;
    if (req.tool === "repository.metadata") {
      if (typeof result.text !== "string") return { kind: "failure", code: "denied" };
      let pkg: unknown;
      try { pkg = JSON.parse(result.text); } catch { return { kind: "failure", code: "denied" }; }
      if (!dataRecord(pkg) || typeof pkg.name !== "string" || typeof pkg.version !== "string") return { kind: "failure", code: "denied" };
      payload = { name: pkg.name, version: pkg.version };
    } else payload = req.tool === "file.metadata" ? { sizeBytes: result.sizeBytes } : { text: result.text };
    if (req.tool === "file.text" && typeof result.text === "string" && /(?:secret|credential|password|passwd|token|cookie|oauth|authorization|private[-_]?key|api[-_]?key)/i.test(result.text)) return { kind: "failure", code: "denied" };
    const redacted = safe({ requestedPath: path, canonicalPath: result.canonicalPath, result: payload });
    if (!dataRecord(redacted) || typeof redacted.requestedPath !== "string" || typeof redacted.canonicalPath !== "string") return { kind: "failure", code: "denied" };
    return { kind: "completed", evidence: { category: "investigation", requestId: inputs.facts.requestId, exactActionId: inputs.facts.exactActionId, capability: req.tool, provenance: "permission-system permitted local fact", secretSafe: true, untrusted: true, requestedPath: redacted.requestedPath, canonicalPath: redacted.canonicalPath, result: redacted.result } };
  } catch { return { kind: "failure", code: "probe" }; }
  finally { clearTimeout(timer!); inputs.signal?.removeEventListener("abort", abort); }
}
