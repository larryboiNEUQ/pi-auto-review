import type {
  DelegatedApprovalFacts,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

export function makeFacts(
  overrides: Partial<DelegatedApprovalFacts> = {},
): DelegatedApprovalFacts {
  return {
    version: 1,
    requestId: "req-1",
    surface: "bash",
    value: "git status",
    action: {
      kind: "shell",
      toolName: "bash",
      command: "git status",
      path: null,
      target: null,
      input: { command: "git status" },
      mcp: null,
      authentication: {
        credentialPresent: false,
        valuesIncluded: false,
        mechanism: null,
      },
    },
    cwd: "/work/repo",
    accessIntent: {
      surface: "bash",
      matchValues: ["git status"],
      boundaryValue: null,
    },
    policy: {
      state: "ask",
      source: "bash",
      origin: "builtin",
      matchedPattern: "*",
      reason: null,
    },
    permissionDelta: {
      from: "ask",
      to: "allow_once",
      surface: "bash",
      value: "git status",
    },
    redactions: [],
    complete: true,
    missing: [],
    exactActionId: "action-1",
    ...overrides,
  };
}

export function makeDetails(
  facts = makeFacts(),
): PromptPermissionDetails {
  return {
    requestId: facts.requestId,
    source: "tool_call",
    agentName: null,
    message: "Run git status to inspect the repository.",
    toolCallId: "tc-1",
    toolName: "bash",
    command: "git status",
    cwd: "/work/repo",
    accessIntent: facts.accessIntent ?? undefined,
    delegatedApproval: facts,
  };
}
