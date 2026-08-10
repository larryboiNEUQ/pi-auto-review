import type {
  DelegatedApprovalFacts,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { redactSecrets } from "./redaction";

export type EvidenceCategory = "user" | "assistant" | "tool_call" | "tool_result" | "system";

export interface DossierEvidence {
  category: EvidenceCategory;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  truncated: boolean;
}

export interface ApprovalDossier {
  schemaVersion: 1;
  request: {
    id: string;
    source: PromptPermissionDetails["source"];
    agentName: string | null;
  };
  action: DelegatedApprovalFacts;
  agentJustification: string;
  evidence: DossierEvidence[];
  override: {
    exactActionId: string;
    priorDenialId: string;
    explicitlyAuthorizedByUser: true;
    oneShot: true;
  } | null;
  limitations: {
    osSandboxPresent: false;
    statement: string;
  };
}

export interface EvidenceSelectionPolicy {
  /** Tool output is untrusted and excluded unless the operator opts in. */
  includeToolResults: boolean;
}

const MAX_EVIDENCE_ITEMS_PER_CATEGORY = 20;
const EVIDENCE_BUDGET_CHARS: Readonly<Record<EvidenceCategory, number>> = {
  user: 12_000,
  assistant: 6_000,
  tool_call: 4_000,
  tool_result: 4_000,
  system: 3_000,
};

interface EvidenceCandidate {
  category: EvidenceCategory;
  role: DossierEvidence["role"];
  text: string;
  order: number;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (typeof part !== "object" || part === null) return [];
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  });
}

function candidatesForMessage(
  message: Record<string, unknown>,
  entryIndex: number,
  policy: EvidenceSelectionPolicy,
): EvidenceCandidate[] {
  const rawRole = message.role;
  if (rawRole === "toolResult" || rawRole === "tool") {
    if (!policy.includeToolResults) return [];
    const text = textParts(message.content).join("\n");
    if (!text) return [];
    const toolName =
      typeof message.toolName === "string" ? `${message.toolName} result: ` : "";
    return [{
      category: "tool_result",
      role: "tool",
      text: `${toolName}${text}`,
      order: entryIndex * 1_000,
    }];
  }

  const role =
    rawRole === "user" || rawRole === "assistant"
      ? rawRole
      : rawRole === "system"
        ? "system"
        : undefined;
  if (!role) return [];

  const candidates: EvidenceCandidate[] = textParts(message.content).map(
    (text, partIndex) => ({
      category: role,
      role,
      text,
      order: entryIndex * 1_000 + partIndex,
    }),
  );
  if (role !== "assistant" || !Array.isArray(message.content)) return candidates;

  for (const [partIndex, part] of message.content.entries()) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "toolCall" || typeof record.name !== "string") continue;
    candidates.push({
      category: "tool_call",
      role: "assistant",
      text: JSON.stringify(
        redactSecrets({ name: record.name, arguments: record.arguments ?? {} }),
      ),
      order: entryIndex * 1_000 + partIndex,
    });
  }
  return candidates;
}

export function selectEvidence(
  entries: readonly unknown[],
  policy: EvidenceSelectionPolicy = { includeToolResults: false },
): DossierEvidence[] {
  const candidates = entries.flatMap((entry, entryIndex) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const message =
      typeof record.message === "object" && record.message !== null
        ? (record.message as Record<string, unknown>)
        : record;
    return candidatesForMessage(message, entryIndex, policy);
  });
  const selected: Array<DossierEvidence & { order: number }> = [];

  for (const category of Object.keys(EVIDENCE_BUDGET_CHARS) as EvidenceCategory[]) {
    let remaining = EVIDENCE_BUDGET_CHARS[category];
    let retained = 0;
    for (const candidate of candidates.toReversed()) {
      if (
        candidate.category !== category ||
        remaining <= 0 ||
        retained >= MAX_EVIDENCE_ITEMS_PER_CATEGORY
      ) {
        continue;
      }
      const safeText = String(redactSecrets(candidate.text));
      if (!safeText) continue;
      const truncated = safeText.length > remaining;
      selected.push({
        category,
        role: candidate.role,
        text: safeText.slice(0, remaining),
        truncated,
        order: candidate.order,
      });
      remaining -= Math.min(safeText.length, remaining);
      retained++;
    }
  }

  return selected
    .sort((left, right) => left.order - right.order)
    .map(({ order: _order, ...evidence }) => evidence);
}

export function buildApprovalDossier(inputs: {
  details: PromptPermissionDetails;
  evidence: readonly unknown[];
  evidencePolicy?: EvidenceSelectionPolicy;
  override?: ApprovalDossier["override"];
}): ApprovalDossier | null {
  const action = inputs.details.delegatedApproval;
  if (!action?.complete || action.policy.state !== "ask") return null;
  return {
    schemaVersion: 1,
    request: {
      id: inputs.details.requestId,
      source: inputs.details.source,
      agentName: inputs.details.agentName,
    },
    action,
    agentJustification: String(redactSecrets(inputs.details.message)),
    evidence: selectEvidence(inputs.evidence, inputs.evidencePolicy),
    override: inputs.override ?? null,
    limitations: {
      osSandboxPresent: false,
      statement:
        "This review changes only who decides an existing Pi ask; it provides no OS sandbox containment.",
    },
  };
}
