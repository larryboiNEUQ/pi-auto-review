import type { DelegatedApprovalFacts, PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import { redactSecrets } from "./redaction";
import type { ProbeEvidence } from "./read-only-probes";

export type EvidenceCategory = "user" | "assistant" | "tool_call" | "tool_result" | "system";
export const EVIDENCE_CONTRACT_VERSION = "bounded-provenance-v1";
export interface DossierEvidence {
  category: EvidenceCategory;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  truncated: boolean;
  callId?: string;
  sessionId?: string;
  provenance: "host-user" | "assistant" | "tool-fact" | "system";
}
export interface EvidenceDiagnostics {
  omittedEntries: number;
  truncatedEntries: number;
  toolResultsIncluded: boolean;
  omissionReasons: string[];
  omissionCounts: Record<string, number>;
}
export interface EvidenceSelection { evidence: DossierEvidence[]; diagnostics: EvidenceDiagnostics }
export interface ApprovalDossier {
  schemaVersion: 1;
  evidenceContractVersion: typeof EVIDENCE_CONTRACT_VERSION;
  request: { id: string; source: PromptPermissionDetails["source"]; agentName: string | null };
  action: DelegatedApprovalFacts;
  agentJustification: string;
  evidence: DossierEvidence[];
  evidenceDiagnostics: EvidenceDiagnostics;
  probeEvidence: ProbeEvidence[];
  override: { exactActionId: string; priorDenialId: string; explicitlyAuthorizedByUser: true; oneShot: true } | null;
  limitations: { osSandboxPresent: false; statement: string };
}
export interface EvidenceSelectionPolicy { includeToolResults: boolean; ownerSessionId?: string }

// Conservative estimate of four characters per token; provider tokenizers differ.
const USER_BUDGET_CHARS = 80_000; // approximately 20k tokens, aggregate history profile
const ASSISTANT_MESSAGE_CHARS = 20_000; // approximately 5k tokens per assistant message
const TOOL_ENTRY_CHARS = 4_000; // approximately 1k tokens per tool result
const NON_USER_BUDGET_CHARS = 80_000; // approximately 20k tokens aggregate
const TOOL_BUDGET_CHARS = 40_000; // approximately 10k tokens aggregate
const MAX_NON_USER_MESSAGES = 40;
const MAX_USER_MESSAGES = 100;
type Candidate = DossierEvidence & { order: number; messageKey: string };

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    return (part.type === undefined || part.type === "text") && typeof part.text === "string" ? [part.text] : [];
  });
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function messageFor(entry: unknown): { wrapper: Record<string, unknown>; message: Record<string, unknown> } | undefined {
  if (!isRecord(entry)) return undefined;
  const nested = isRecord(entry.message) ? entry.message : entry;
  // Only Pi message entries can attest nested user/system roles; custom data
  // containing a `message` object is not a host-authenticated conversation turn.
  if ((nested.role === "user" || nested.role === "system") && entry.type !== "message" && (nested !== entry || entry.type !== undefined)) return undefined;
  return { wrapper: entry, message: nested };
}
function safe(value: string): string {
  let text = String(redactSecrets(value));
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") text = JSON.stringify(redactSecrets(parsed));
  } catch { /* Narrative text can contain embedded JSON snippets. */ }
  // Also catch credential-key/value fragments inside otherwise narrative output.
  return text.replace(/("(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|authorization|cookie|credential|passwd|password|private[_-]?key|secret|session[_-]?token|token)"\s*:\s*)(?:"(?:\\.|[^"\\])*"|\[[^\]]*\]|\{[^}]*\}|[^\s,}\]]+)/gi, '$1"[REDACTED_SECRET]"');
}
function addCount(counts: Record<string, number>, reason: string): void { counts[reason] = (counts[reason] ?? 0) + 1; }

export function selectEvidenceDetailed(entries: readonly unknown[], policy: EvidenceSelectionPolicy = { includeToolResults: true }): EvidenceSelection {
  const candidates: Candidate[] = [];
  const omissionCounts: Record<string, number> = {};
  const messageKeys: Array<{ index: number; role: unknown; key: string }> = [];
  entries.forEach((entry, index) => {
    const found = messageFor(entry);
    if (!found) return;
    const { wrapper, message } = found;
    // Pi's active context list replaces earlier turns with a compaction entry.
    // Its summary is not an authenticated substitute for missing user grants/restrictions.
    if (wrapper.type === "compaction") addCount(omissionCounts, "compacted_user_history");
    // A branch-local context edit can replace or remove an earlier user grant
    // without changing the raw entry. Never reuse the unprojected grant.
    if (wrapper.type === "context_edit") addCount(omissionCounts, "edited_context_history");
    const role = message.role;
    const key = typeof wrapper.id === "string" ? wrapper.id : `entry-${index}`;
    if (role === "assistant" || role === "toolResult" || role === "tool" || role === "system") messageKeys.push({ index, role, key });
    const ownerSessionId = policy.ownerSessionId; // Never trust transcript wrapper metadata as ownership.
    if (role === "user") {
      const parts = textParts(message.content);
      if (!parts.length || (Array.isArray(message.content) && message.content.length > parts.length)) {
        addCount(omissionCounts, "user_unsupported_content");
      }
      for (const text of parts) candidates.push({ category: "user", role: "user", text, truncated: false, provenance: "host-user", order: index, messageKey: key });
      return;
    }
    if (role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          candidates.push({ category: "assistant", role: "assistant", text: part.text, truncated: false, provenance: "assistant", order: index, messageKey: key, ...(ownerSessionId ? { sessionId: ownerSessionId } : {}) });
        } else if (part.type === "toolCall" && typeof part.name === "string") {
          const call = { name: part.name, arguments: part.arguments ?? {} } as Record<string, unknown>;
          if (typeof part.id === "string") call.id = part.id;
          candidates.push({ category: "tool_call", role: "assistant", text: JSON.stringify(redactSecrets(call)), truncated: false, provenance: "assistant", order: index, messageKey: key, ...(typeof part.id === "string" ? { callId: part.id } : {}), ...(ownerSessionId ? { sessionId: ownerSessionId } : {}) });
        }
        // Thinking and signatures are deliberately excluded.
      }
      return;
    }
    if (role === "toolResult" || role === "tool") {
      if (!policy.includeToolResults) { addCount(omissionCounts, "tool_results_opted_out"); return; }
      // Redact each body before the synthetic result label; a pure JSON receipt
      // must remain parseable for structural credential-key redaction.
      const body = textParts(message.content).map(safe).join("\n");
      if (!body) return;
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const name = typeof message.toolName === "string" ? message.toolName : "tool";
      candidates.push({ category: "tool_result", role: "tool", text: `${name} result${callId ? ` (call ${callId})` : ""}: ${body}`, truncated: false, provenance: "tool-fact", order: index, messageKey: key, ...(callId ? { callId } : {}), ...(ownerSessionId ? { sessionId: ownerSessionId } : {}) });
      return;
    }
    if (role === "system") {
      const sections = isRecord(message.sections)
        ? Object.entries(message.sections).filter(([, value]) => typeof value === "string").map(([name, value]) => `${name}: ${value}`)
        : [];
      for (const text of [...textParts(message.content), ...sections]) candidates.push({ category: "system", role: "system", text, truncated: false, provenance: "system", order: index, messageKey: key });
    }
  });

  const selected: Candidate[] = [];
  const userMessages = [...new Set(candidates.filter((c) => c.category === "user").map((c) => c.messageKey))];
  const keptUserMessages = new Set(userMessages.slice(-MAX_USER_MESSAGES));
  for (const key of userMessages) if (!keptUserMessages.has(key)) addCount(omissionCounts, "user_message_limit");
  let userRemaining = USER_BUDGET_CHARS;
  for (const c of candidates.filter((x) => x.category === "user" && keptUserMessages.has(x.messageKey))) {
    if (userRemaining <= 0) { addCount(omissionCounts, "user_budget"); continue; }
    const text = safe(c.text);
    const kept = text.slice(0, userRemaining);
    selected.push({ ...c, text: kept, truncated: kept.length < text.length });
    userRemaining -= kept.length;
    if (kept.length < text.length) addCount(omissionCounts, "user_budget_truncation");
  }

  const recent = messageKeys.filter((m) => m.role !== "system").slice(-MAX_NON_USER_MESSAGES);
  const recentKeys = new Set([...recent.map((m) => m.key), ...messageKeys.filter((m) => m.role === "system").map((m) => m.key)]);
  for (const m of messageKeys) if (!recentKeys.has(m.key)) addCount(omissionCounts, "recent_non_user_limit");
  let nonUserRemaining = NON_USER_BUDGET_CHARS;
  let toolRemaining = TOOL_BUDGET_CHARS;
  const assistantUsed = new Map<string, number>();
  const prioritizedNonUser = candidates
    .filter((x) => x.category !== "user" && recentKeys.has(x.messageKey))
    .sort((a, b) => {
      const rank = (item: Candidate) => item.category === "tool_call" || item.category === "tool_result" ? 0 : 1;
      return rank(a) - rank(b) || b.order - a.order;
    });
  for (const c of prioritizedNonUser) {
    const text = safe(c.text);
    const assistantLike = c.category === "assistant" || c.category === "tool_call" || c.category === "system";
    const perEntryRemaining = c.category === "tool_result"
      ? Math.min(TOOL_ENTRY_CHARS, toolRemaining)
      : assistantLike ? Math.max(0, ASSISTANT_MESSAGE_CHARS - (assistantUsed.get(c.messageKey) ?? 0)) : 0;
    const allowed = Math.min(perEntryRemaining, nonUserRemaining);
    if (!allowed) { addCount(omissionCounts, c.category === "system" ? "system_budget" : c.category === "tool_result" ? "tool_budget" : "non_user_budget"); continue; }
    const kept = text.slice(0, allowed);
    const truncated = kept.length < text.length;
    selected.push({ ...c, text: kept, truncated });
    nonUserRemaining -= kept.length;
    if (c.category === "tool_result") toolRemaining -= kept.length;
    else assistantUsed.set(c.messageKey, (assistantUsed.get(c.messageKey) ?? 0) + kept.length);
    if (truncated) addCount(omissionCounts, c.category === "system" ? "system_entry_truncation" : c.category === "tool_result" ? "tool_entry_truncation" : "assistant_entry_truncation");
  }
  // Selection boundaries and aggregate budgets must not leave a causal pair
  // half-present. Calls with no result anywhere in this branch remain valid.
  const knownCalls = new Set(candidates.filter((c) => c.category === "tool_call" && c.callId).map((c) => c.callId));
  const knownResults = new Set(candidates.filter((c) => c.category === "tool_result" && c.callId).map((c) => c.callId));
  for (const callId of knownCalls) {
    if (!callId || !knownResults.has(callId)) continue;
    const hasCall = selected.some((c) => c.category === "tool_call" && c.callId === callId);
    const hasResult = selected.some((c) => c.category === "tool_result" && c.callId === callId);
    if (hasCall === hasResult) continue;
    for (let index = selected.length - 1; index >= 0; index--) {
      if (selected[index]?.callId === callId && (selected[index]?.category === "tool_call" || selected[index]?.category === "tool_result")) {
        selected.splice(index, 1);
        addCount(omissionCounts, "causal_pair_unavailable");
      }
    }
  }
  selected.sort((a, b) => a.order - b.order);
  const reasons = Object.keys(omissionCounts).sort();
  return {
    evidence: selected.map(({ messageKey: _key, order: _order, ...e }) => e),
    diagnostics: {
      omittedEntries: Object.values(omissionCounts).reduce((a, b) => a + b, 0),
      truncatedEntries: selected.filter((e) => e.truncated).length,
      toolResultsIncluded: policy.includeToolResults,
      omissionReasons: reasons,
      omissionCounts,
    },
  };
}
export function selectEvidence(entries: readonly unknown[], policy: EvidenceSelectionPolicy = { includeToolResults: true }): DossierEvidence[] {
  return selectEvidenceDetailed(entries, policy).evidence;
}

export function buildApprovalDossier(inputs: {
  details: PromptPermissionDetails; evidence: readonly unknown[]; evidencePolicy?: EvidenceSelectionPolicy;
  override?: ApprovalDossier["override"]; completedAction?: DelegatedApprovalFacts; probeEvidence?: ProbeEvidence[];
}): ApprovalDossier | null {
  const action = inputs.completedAction ?? inputs.details.delegatedApproval;
  if (!action?.complete || action.policy.state !== "ask") return null;
  const selection = selectEvidenceDetailed(inputs.evidence, inputs.evidencePolicy);
  return {
    schemaVersion: 1, evidenceContractVersion: EVIDENCE_CONTRACT_VERSION,
    request: { id: inputs.details.requestId, source: inputs.details.source, agentName: inputs.details.agentName },
    action, agentJustification: safe(inputs.details.message), evidence: selection.evidence,
    evidenceDiagnostics: selection.diagnostics,
    probeEvidence: inputs.probeEvidence ?? [], override: inputs.override ?? null,
    limitations: { osSandboxPresent: false, statement: "This review changes only who decides an existing Pi ask; it provides no OS sandbox containment." },
  };
}
