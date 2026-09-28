import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authorizationBranchIds } from "./authorization-branch";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import { createDeniedPermissionDecision } from "#src/authority/permission-dialog";
import type { PermissionQuery } from "#src/service";
import {
  type Authorizer,
  type AuthorizerSelectionDeps,
  selectAuthorizer,
  type TerminalAuthorizer,
} from "./authorizer";
import { composeAuthorizerChain } from "./authorizer-chain";
import type { AuthorizerLookup } from "./authorizer-registry";
import { encloseInDelegationEnvelope } from "./delegation-envelope";
import type {
  PermissionPrompterApi,
  PromptPermissionDetails,
} from "./permission-prompter";

/**
 * The lifecycle slice of the selection owner that PermissionSession drives.
 *
 * PermissionSession calls activate/deactivate to keep the selection's stored
 * context in sync with its own — the same pattern the former
 * PromptingGatewayLifecycle used.
 */
export interface AuthorizerSelectionLifecycle {
  activate(ctx: ExtensionContext): void;
  deactivate(): void;
}

/**
 * The ask-escalation seam `GateRunner` depends on: escalate a single ask to
 * the session's selected `Authorizer` and return its decision.
 *
 * Replaces the two-method `GatePrompter` role (#556). There is no
 * "can anyone answer" pre-check: absent authority is the `DenyingAuthorizer`,
 * which answers by denying with a `confirmationUnavailable` marker.
 */
export interface AskEscalator {
  escalate(details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}

/**
 * Context-owning selection root for the Authorizer spine.
 *
 * The rewrite of `PromptingGateway`: owns the stored `ExtensionContext`, runs
 * `selectAuthorizer` once per activation, and implements `AskEscalator` by
 * delegating to the selected `Authorizer` via `PermissionPrompter`.
 *
 * `selectAuthorizer` encodes the liveness decision in *which* `Authorizer` it
 * returns (`LocalUserAuthorizer` / `ParentAuthorizer` when authority is
 * reachable, `DenyingAuthorizer` otherwise), so no separate confirmability
 * predicate survives (#556 dissolved `canConfirm()`).
 */
/** Only host-owned session/branch identity and the pending-input bit guard release. */
function approvalEpoch(ctx: ExtensionContext): string | null {
  try {
    if (ctx.hasPendingMessages()) return null;
    const owner = ctx.sessionManager.getSessionId();
    const branchIds = authorizationBranchIds(ctx.sessionManager.getBranch());
    if (!owner || !branchIds) return null;
    return createHash("sha256").update(JSON.stringify([owner, branchIds])).digest("hex");
  } catch {
    return null; // No available host proof is never an approval.
  }
}

export class AuthorizerSelection
  implements AskEscalator, AuthorizerSelectionLifecycle
{
  private terminal: TerminalAuthorizer | null = null;
  private activeContext: ExtensionContext | null = null;

  constructor(
    private readonly deps: AuthorizerSelectionDeps & {
      prompter: PermissionPrompterApi;
      /** The session-scoped query injected into each chain link (ADR 0007 §3). */
      getPermissionQuery: () => PermissionQuery;
      /** Read-only lookup of registered links by name. */
      authorizerRegistry: AuthorizerLookup;
      /** The operator's configured link names, read live per ask. */
      getAuthorizerChain: () => string[];
    },
  ) {}

  /**
   * Select the terminal Authorizer for `ctx` and store it. The non-terminal
   * chain is composed per ask in {@link escalate}, not here: ADR 0007 §4 lets a
   * link register in a `permissions:ready` handler that may fire after
   * activation, so link resolution is deferred to the session's first ask.
   */
  activate(ctx: ExtensionContext): void {
    this.activeContext = ctx;
    this.terminal = selectAuthorizer(ctx, this.deps);
  }

  /**
   * Resolve the operator's `authorizerChain` names to registered links, in
   * config order (ADR 0007 invariant 1). An unregistered name is skipped with a
   * warning (invariant 2 — more prompting, never less). Each resolved link is
   * wrapped with its registered path-envelope mode: the default caps `path` allows
   * to the terminal, while an explicit `honor-reviewer` mode preserves them.
   */
  private resolveConfiguredLinks(): Authorizer[] {
    const links: Authorizer[] = [];
    for (const name of this.deps.getAuthorizerChain()) {
      const authorize = this.deps.authorizerRegistry.get(name);
      if (authorize === undefined) {
        this.deps.logger.review("authorizer_chain_unregistered_link", { name });
        continue;
      }
      links.push({
        authorize: encloseInDelegationEnvelope(
          authorize,
          this.deps.authorizerRegistry.getPathEnvelopeMode(name),
        ),
      });
    }
    return links;
  }

  /** Clear the stored selection. */
  deactivate(): void {
    this.terminal = null;
    this.activeContext = null;
  }

  /**
   * Escalate an ask through the composed chain and return its decision.
   *
   * Resolves the configured links freshly (so a link registered any time before
   * this first ask is honored) and composes them ahead of the selected
   * terminal. With zero links the composed chain is the terminal instance; a
   * request-scoped guard around either path invalidates stale approvals.
   *
   * Rejects if no terminal has been selected — i.e. before the session was
   * activated. Implements {@link AskEscalator}.
   */
  escalate(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    if (this.terminal === null) {
      return Promise.reject(
        new Error("escalate called before the session was activated"),
      );
    }
    const context = this.activeContext;
    const before = context && approvalEpoch(context);
    const chain = composeAuthorizerChain(
      this.resolveConfiguredLinks(),
      this.terminal,
      this.deps.getPermissionQuery(),
    );
    // The prompter awaits the entire chain, including any terminal dialog.
    // Validate at that final release seam, before it logs an approval or the
    // GateRunner records a session rule / releases the executor.
    const guarded: TerminalAuthorizer = {
      authorize: async (pending) => {
        if (!before) return createDeniedPermissionDecision("Session context or pending user input requires a fresh approval request.");
        const decision = await chain.authorize(pending);
        if (decision.approved && (this.activeContext !== context || approvalEpoch(context) !== before)) {
          return createDeniedPermissionDecision("Approval context changed while waiting; retry the exact action.");
        }
        return decision;
      },
    };
    return this.deps.prompter.prompt(guarded, details);
  }
}
