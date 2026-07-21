# Pi Git Install and Codex-Aligned Delegated Approval

**Status:** ready-for-agent

## Problem Statement

The local Pi permission fork currently cannot be installed as a functioning bundle from its GitHub repository URL. Pi can clone and record the repository, but the repository root does not declare installable workspaces or extension resources, so dependencies are not installed and the two nested extensions are not discovered.

After manual path installation, the approval experience also differs materially from Codex “Approve for me.” The permission system defaults many ordinary actions to `ask`, while safe-allow only reviews `external_directory` requests with a thin path-oriented prompt. Routine local work, Bash, MCP, and other approval surfaces can still stop for manual confirmation. The reviewer lacks the conversation evidence, exact action dossier, semantic risk model, user-authorization assessment, denial lifecycle, and failure behavior documented for Codex Auto-review.

The user wants a low-interruption delegated-approval experience aligned with Codex, but does not require an OS sandbox. The implementation must not claim sandbox-equivalent containment.

## Solution

Make the repository a self-contained Pi Git package that installs both permission extensions, their runtime dependencies, and their internal workspace link from one GitHub URL.

Replace the external-directory-only safe-allow behavior with a Codex-aligned delegated reviewer. The permission system remains responsible for deterministic `allow`, `ask`, and `deny` boundaries. Routine actions already allowed by policy execute directly. Every eligible `ask` becomes a precise approval dossier and is routed to an independent reviewer before any user prompt. The reviewer evaluates the exact action’s intrinsic risk and the user’s semantic authorization, then returns `allow` or `deny` with a rationale. Failures block execution. A denial can be retried only after a materially safer action or explicit user authorization for that exact action.

The behavioral acceptance oracle is the official Codex Auto-review documentation, the open-source Guardian policy and request/review contracts, and the user’s verified local Codex configuration. Alignment covers reviewer routing, dossier semantics, risk and authorization scoring, verdict behavior, failure behavior, MCP/Skill treatment, denial handling, and auditability. Alignment explicitly excludes OS sandbox enforcement.

## User Stories

1. As a Pi user, I want to install the fork from one GitHub URL, so that I do not need to clone it manually or install two package directories separately.
2. As a Pi user, I want a successful install to mean the extensions are actually discovered and loaded, so that a recorded package source is not mistaken for a working installation.
3. As a Pi user, I want the permission-system extension to load before safe-allow, so that the reviewer can register against an available permissions service.
4. As a Pi user, I want safe-allow to resolve the matching permission-system workspace package, so that it never binds to an incompatible registry copy.
5. As a Pi user, I want Git package updates to preserve the same dependency and extension-loading behavior, so that upgrading does not silently break approval review.
6. As a Pi user, I want ordinary actions already allowed by policy to run without review, so that delegated approval does not add latency to routine work.
7. As a Pi user, I want every eligible action that would otherwise require me to approve it to be routed to a reviewer, so that Pi can approve on my behalf.
8. As a Pi user, I want Bash approval to consider the exact command, working directory, targets, conversation, and requested side effects, so that decisions are contextual rather than command-name blacklists.
9. As a Pi user, I want a narrowly scoped destructive-looking command to be judged by its verified target and my authorization, so that safe intentional actions are not rejected only because they contain tokens such as `rm -rf`.
10. As a Pi user, I want dynamically constructed actions with unknown final payloads to fail closed, so that the reviewer does not approve behavior it cannot inspect.
11. As a Pi user, I want ordinary trusted Skill invocation to avoid approval, so that frequently used workflows remain frictionless.
12. As a Pi user, I want actions produced by a Skill to pass through their real file, Bash, network, MCP, or special-operation boundaries, so that a trusted Skill does not become a blanket capability grant.
13. As a Pi user, I want MCP approval to include server identity, tool metadata, annotations, connected account, and exact arguments, so that read-only and side-effecting calls can be distinguished semantically.
14. As a Pi user, I want the reviewer to consider whether I authorized the material goal, payload, target, and side effects, so that agent drift is not mistaken for permission.
15. As a Pi user, I want low- and medium-risk actions to proceed automatically when policy permits, so that common work does not stop for manual approval.
16. As a Pi user, I want high-risk actions to require adequate user authorization and a narrow blast radius, so that broad implied intent is not over-read.
17. As a Pi user, I want critical actions and absolute policy violations denied, so that delegated review cannot override hard safety boundaries.
18. As a Pi user, I want credentials used through a service-native authentication path to be distinguished from secret disclosure, so that normal authenticated workflows can proceed without exposing credential values.
19. As a Pi user, I want reviewer prompts and audit logs to omit secret values, so that the approval system does not create a new exfiltration path.
20. As a Pi user, I want review timeouts, malformed output, missing context, and reviewer-session failures to block execution, so that operational failures never become implicit approval.
21. As a Pi user, I want timeout to be reported separately from an explicit safety denial, so that the main agent does not misrepresent availability failures as proof of danger.
22. As a Pi user, I want an explicit denial rationale returned to the main agent, so that it can choose a materially safer alternative.
23. As a Pi user, I want the main agent prohibited from rephrasing or indirectly retrying the same denied outcome, so that denial cannot be bypassed by command variation.
24. As a Pi user, I want repeated denials to stop the current turn, so that the agent cannot loop indefinitely against the reviewer.
25. As a Pi user, I want to explicitly authorize one exact previously denied action after seeing its risk, so that exceptional work can continue without globally weakening permissions.
26. As a Pi user, I want that exact-action authorization to be narrow and auditable, so that it does not approve similar future actions.
27. As a maintainer, I want reviewer decisions to record risk, authorization, verdict, rationale, duration, and decision source without secrets, so that failures and policy drift can be investigated.
28. As a maintainer, I want the implementation verified against the current official Codex Auto-review and Guardian contracts, so that “Codex-aligned” is an evidence-backed claim rather than a visual resemblance.
29. As a maintainer, I want any intentional divergence from Codex documented in the verification report, so that omitted sandbox guarantees and Pi-specific constraints remain explicit.
30. As a maintainer, I want macOS and Windows Git-install smoke coverage, so that the personal cross-platform fork remains usable on both target systems.
31. As a Pi user, I want delegated approval to behave consistently on macOS and Windows, so that risk, authorization, verdict, failure, and override semantics do not depend on my operating system.

## Implementation Decisions

- The repository will expose one root Git-installable Pi package backed by workspaces for the two nested extensions.
- The root Pi manifest will list permission-system before safe-allow. Installation must create a resolvable internal workspace relationship rather than require a manually created symlink or junction.
- The Git-install contract targets Pi runtime installation and update. Publishing a public npm package is not required.
- The permission system remains the owner of deterministic `allow`, `ask`, and `deny` boundaries. Safe-allow reviews only eligible `ask` requests and cannot convert a hard `deny` into `allow`.
- No OS sandbox will be added. Documentation and diagnostics must state that behavioral Auto-review alignment does not provide Codex-equivalent filesystem, process, or network containment.
- Routine local file operations that policy already permits will execute without reviewer calls. Trusted Skill selection will not itself create an approval; the Skill’s resulting actions remain independently governed.
- Approval requests will be normalized into a typed dossier carrying request and turn identity, surface, exact action, cwd/workspace facts, requested permission delta, agent justification, relevant conversation/tool evidence, policy facts, and any exact prior denial authorization.
- Action-specific dossier variants will cover shell/exec, file/patch, external paths, network destinations, MCP calls, permission requests, and concrete special operations. A special operation that cannot produce a precise dossier is not eligible for automatic approval.
- Credential values and secret contents will never be included in reviewer context or audit records. The dossier may include derived facts such as credential presence, authentication mechanism, source trust, and destination trust.
- Reviewer output will align with the Codex Guardian decision model: intrinsic risk, semantic user authorization, `allow` or `deny`, and a concise rationale. There is no successful `defer` verdict; missing evidence is a denial/fail-closed result that tells the main agent what must be clarified.
- Default thresholds will align with the referenced Guardian policy: low and medium allow unless a stricter policy applies; high requires at least medium authorization, narrow scope, and no absolute deny; critical denies.
- Static Bash parsing and permission rules remain useful for direct allow, hard deny, action extraction, and dossier construction. They are not the primary semantic risk policy.
- A complete static wrapper/script may be reviewed as one exact action even when it cannot be decomposed into simple commands. A genuinely runtime-dependent payload whose final behavior is absent from the dossier fails closed.
- MCP decisions will use annotations and exact call context rather than a fixed tool-name blacklist. Read-only calls allowed by policy skip review; side-effecting or configured approval calls enter delegated review.
- Reviewer construction, authentication, transport, timeout, cancellation, parse, and session failures block execution. Timeout is represented distinctly from an explicit policy denial.
- Transient reviewer-session and parse failures may retry within one bounded deadline. The implementation will adopt Codex-aligned bounded retry semantics unless a documented Pi runtime constraint requires a narrower limit.
- Explicit denials return a rationale plus a non-circumvention instruction. Repeated denial thresholds will interrupt the current turn rather than permit retry loops.
- User override applies only to the exact denied action, for one retry in the same context, and remains subject to absolute deny policy.
- Structured audit events will be secret-safe and sufficient to reconstruct routing, risk, authorization, verdict, rationale, latency, timeout, retry, denial-breaker, and exact-override behavior.
- The implementation baseline is the official Codex Auto-review and Agent approvals documentation plus the open-source Guardian policy, policy template, approval request, prompt, and review contracts. The initial pinned implementation comparison is local Codex 0.144.4 / `rust-v0.144.4`, observed on 2026-07-21 with `approval_policy = on-request`, `sandbox_mode = workspace-write`, and a Guardian reviewer enabled.
- Before implementation verification is declared complete, the agent must refresh the official sources, record the compared Codex tag/commit and documentation date, and disposition any behavioral drift.
- Delegated approval is a supported product behavior on both macOS and Windows. Platform adapters may normalize shell, path, environment, and process facts differently, but they must feed the same dossier contract and produce the same risk, authorization, verdict, denial, timeout, circuit-breaker, and exact-override semantics.

## Testing Decisions

- Per the user's 2026-07-22 acceptance direction, Issue completion is based on proportionate local verification. CI is useful follow-up evidence but is not a completion gate, and platform-specific execution may be deferred when the implementation includes an equivalent verification path. Any deferred platform run must be reported honestly rather than described as executed.
- The governing acceptance condition is behavioral alignment with the refreshed official Codex Auto-review documentation, Guardian open-source policy/contracts, and the verified local delegated-approval configuration, except for the explicitly excluded OS sandbox.
- Verification must produce a traceability matrix mapping every applicable Codex lifecycle requirement to implementation evidence, automated tests, and any explicit divergence. A generic statement that the behavior is “similar” does not pass.
- The Git-install seam is a real installation into an isolated Pi agent directory followed by Pi resource resolution and extension loading. It must prove dependency installation, exactly two discovered extensions, deterministic load order, internal workspace resolution, clean startup, persisted single Git source, and successful update. `pi list` alone is insufficient.
- The delegated-approval seam is the highest existing authorizer-selection/composition boundary with a real registered safe-allow reviewer, deterministic model and authentication doubles, and a terminal-authorizer spy. Tests assert whether the final action executes, denies, or reaches an exact user override path without coupling to private helper implementation.
- Dossier contract tests will cover each action variant, transcript selection, truncation markers, secret redaction, connected-account and MCP annotations, requested permission facts, prior denial context, and exact-action identity.
- Decision-table tests will cover low/medium/high/critical risk crossed with unknown/low/medium/high user authorization, including tenant or local absolute-deny precedence.
- Bash behavior tests will cover routine commands, narrow destructive actions with verified targets, broad destructive actions, static wrappers, runtime-dependent payloads, command chains, redirects, and agent attempts to rephrase a denied outcome.
- MCP tests will cover read-only annotated calls, destructive/open-world annotations, missing annotations, trusted and untrusted destinations, connected account identity, private-data transfer, and parameter-specific side effects.
- Skill tests will prove that trusted Skill invocation does not itself prompt while actions emitted by the Skill still pass through their native approval surfaces.
- Failure tests will cover auth failure, model resolution failure, transport failure, malformed structured output, retryable parse errors, timeout, cancellation, reviewer-session failure, missing dossier facts, and audit-log write failure. None may execute the action.
- Denial lifecycle tests will cover rationale propagation, non-circumvention instruction, consecutive and rolling-window circuit breakers, materially safer alternatives, exact user re-authorization, one-shot scope, and absolute-deny precedence.
- A real Pi CLI smoke suite will demonstrate: routine local work without reviewer latency; an eligible Bash approval completed without human input; an eligible external-path approval; an MCP side-effect review; a critical exfiltration denial; a reviewer timeout that does not execute; and an exact denied-action override.
- Platform verification will include macOS ARM64 and Windows installation/loading plus the complete delegated-approval acceptance matrix on both operating systems. Behavior tests should remain platform-neutral unless action facts are inherently platform-specific; platform-specific fixtures must cover POSIX shell/path facts on macOS and the actual Pi shell/path/process representation on Windows.
- Ticket 02 may be completed from proportionate local verification when its functional acceptance criteria pass. The macOS and Windows smoke scenarios remain required follow-up coverage, but CI availability and executing both platforms are not completion gates; the verification report must distinguish executed evidence from deferred coverage.
- The verification report must explicitly state that no OS sandbox was added and must not claim security equivalence with Codex sandbox containment.

## Out of Scope

- Implementing macOS Seatbelt, Linux namespaces/seccomp, Windows AppContainer, Landstrip, or any other OS sandbox.
- Claiming that static Pi tool/Bash analysis can contain hidden process side effects as strongly as Codex sandboxing.
- Replacing Pi’s entire permission-system policy language.
- Public npm publication, marketplace submission, or redistribution licensing work.
- Computer Use app-level approval behavior.
- Broad organization/tenant managed-policy administration UI.
- The TUI corruption/noise caused by safe-allow `register.skip` console output; that will be specified and ticketed separately after this work.

## Further Notes

- Research baseline: `.scratch/codex-delegated-approval-research/findings.md`.
- Primary references are the official Codex Auto-review manual, Agent approvals and security manual, Rules manual, MCP/configuration documentation, and the OpenAI Codex Guardian source contracts.
- The local Codex configuration is evidence for the desired interaction mode, not a public compatibility API.
- The main security limitation is deliberate: without an OS sandbox, the reviewer can judge only the action represented in the dossier. Hidden runtime behavior omitted by the tool or parser cannot be contained after approval.
