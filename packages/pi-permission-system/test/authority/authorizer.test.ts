import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ParentAuthorizer } from "#src/authority/approval-escalator";
import {
  type AuthorizerSelectionDeps,
  selectAuthorizer,
} from "#src/authority/authorizer";
import { DenyingAuthorizer } from "#src/authority/denying-authorizer";
import { SubagentDetection } from "#src/authority/subagent-detection";
import { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { SubagentDetector } from "#src/authority/subagent-detection";
import { posixPathFlavor } from "#src/path/path-flavor";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(hasUI: boolean): ExtensionContext {
  return {
    hasUI,
    mode: "tui",
    ui: { select: vi.fn(), input: vi.fn(), custom: vi.fn() },
    sessionManager: {
      getSessionId: vi.fn().mockReturnValue("session-1"),
      getSessionDir: vi.fn().mockReturnValue("/sessions/session-1"),
      getEntries: vi.fn().mockReturnValue([]),
      getSessionName: vi.fn().mockReturnValue("Explore#unknown8"),
      getHeader: vi.fn().mockReturnValue({
        parentSession: "/sessions/untrusted-parent.jsonl",
      }),
    },
  } as unknown as ExtensionContext;
}

function makeDetection(isSubagent = false): SubagentDetector {
  return { isSubagent: vi.fn().mockReturnValue(isSubagent) };
}

function makeDeps(
  overrides: Partial<AuthorizerSelectionDeps> = {},
): AuthorizerSelectionDeps {
  return {
    detection: overrides.detection ?? makeDetection(),
    events: overrides.events ?? {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => undefined),
    },
    getPromptPreferences:
      overrides.getPromptPreferences ??
      (() => ({ doublePressToConfirm: true })),
    requestPermissionDecision:
      overrides.requestPermissionDecision ??
      vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    forwardingDir: overrides.forwardingDir ?? "/tmp/forwarding",
    registry: overrides.registry,
    logger: overrides.logger ?? { review: vi.fn(), debug: vi.fn() },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("selectAuthorizer", () => {
  it("selects LocalUserAuthorizer when the context has UI", () => {
    const authorizer = selectAuthorizer(makeCtx(true), makeDeps());
    expect(authorizer).toBeInstanceOf(LocalUserAuthorizer);
  });

  it("selects LocalUserAuthorizer even when the context is also a subagent", () => {
    const authorizer = selectAuthorizer(
      makeCtx(true),
      makeDeps({ detection: makeDetection(true) }),
    );
    expect(authorizer).toBeInstanceOf(LocalUserAuthorizer);
  });

  it("selects ParentAuthorizer when there is no UI but the context is a subagent", () => {
    const authorizer = selectAuthorizer(
      makeCtx(false),
      makeDeps({ detection: makeDetection(true) }),
    );
    expect(authorizer).toBeInstanceOf(ParentAuthorizer);
  });

  it("selects DenyingAuthorizer when there is no UI and no subagent", () => {
    const authorizer = selectAuthorizer(
      makeCtx(false),
      makeDeps({ detection: makeDetection(false) }),
    );
    expect(authorizer).toBeInstanceOf(DenyingAuthorizer);
  });

  it("keeps ordinary no-UI confirmation unavailable without a trusted lineage signal", async () => {
    const ctx = makeCtx(false);
    const authorizer = selectAuthorizer(
      ctx,
      makeDeps({
        detection: new SubagentDetection({
          subagentSessionsDir: "/sessions/subagents",
          flavor: posixPathFlavor,
          registry: new SubagentSessionRegistry(),
        }),
      }),
    );

    expect(authorizer).toBeInstanceOf(DenyingAuthorizer);
    await expect(authorizer.authorize({} as never)).resolves.toMatchObject({
      approved: false,
      confirmationUnavailable: true,
    });
  });
});
