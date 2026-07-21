import type {
  DelegatedApprovalFacts,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

import { redactSecrets } from "./redaction";

export interface DossierEvidence {
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

const MAX_EVIDENCE_ITEMS = 20;
const MAX_EVIDENCE_CHARS = 12_000;

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part !== "object" || part === null) return "";
        const record = part as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function selectEvidence(entries: readonly unknown[]): DossierEvidence[] {
  const selected: DossierEvidence[] = [];
  let remaining = MAX_EVIDENCE_CHARS;
  for (const entry of entries.slice(-MAX_EVIDENCE_ITEMS).reverse()) {
    if (remaining <= 0 || typeof entry !== "object" || entry === null) break;
    const record = entry as Record<string, unknown>;
    const message =
      typeof record.message === "object" && record.message !== null
        ? (record.message as Record<string, unknown>)
        : record;
    const rawRole = message.role;
    const role =
      rawRole === "user" || rawRole === "assistant" || rawRole === "tool"
        ? rawRole
        : rawRole === "system"
          ? "system"
          : undefined;
    const text = contentText(message.content);
    if (!role || !text) continue;
    const safeText = String(redactSecrets(text));
    const truncated = safeText.length > remaining;
    selected.push({ role, text: safeText.slice(0, remaining), truncated });
    remaining -= Math.min(safeText.length, remaining);
  }
  return selected.reverse();
}

export function buildApprovalDossier(inputs: {
  details: PromptPermissionDetails;
  evidence: readonly unknown[];
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
    evidence: selectEvidence(inputs.evidence),
    override: inputs.override ?? null,
    limitations: {
      osSandboxPresent: false,
      statement:
        "This review changes only who decides an existing Pi ask; it provides no OS sandbox containment.",
    },
  };
}
