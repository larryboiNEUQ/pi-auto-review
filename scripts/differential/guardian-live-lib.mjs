/** Non-network helpers for the operator-authorized Guardian live comparison. */

export const HARD_CAP = 200;
export const BASELINE_COMMIT = "3ccc7d703f7895cfaf0c4a50284530dd60308414";
export const LIVE_OPT_IN = "PI_GUARDIAN_LIVE_COMPARISON";

export function liveSettings(provider, model) {
  return {
    backend: "chat",
    provider,
    model,
    repeats: 3,
    // openai-codex-responses rejects an explicit temperature parameter.
    // Both revisions omit it and use the provider default. Do not record 0.
    temperature: null,
    sampling: "provider-default",
    maxAttempts: 1,
    includeToolResults: true,
    readOnlyProbes: false,
    investigationEnabled: false,
  };
}

export function assertLiveOptIn(env, argv) {
  const flags = new Set(argv);
  if (!flags.has("--live") || env[LIVE_OPT_IN] !== "1" || !flags.has("--acknowledge-model-charges")) {
    throw new Error("Live comparison is opt-in only. Set PI_GUARDIAN_LIVE_COMPARISON=1 and pass --live --acknowledge-model-charges. Default CI does not run it.");
  }
}

export function parseLiveArgs(argv) {
  const flags = new Set();
  const values = {};
  const valued = new Set(["--provider", "--model", "--output-dir", "--pi-cmd", "--max-calls", "--baseline-commit"]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (["--live", "--acknowledge-model-charges", "--resume"].includes(arg)) { flags.add(arg); continue; }
    if (!valued.has(arg) || !argv[index + 1] || argv[index + 1].startsWith("--") || values[arg]) {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    values[arg] = argv[++index];
  }
  if (!values["--provider"]?.trim() || !values["--model"]?.trim() || !values["--output-dir"]?.trim() || !values["--pi-cmd"]?.trim()) {
    throw new Error("Live mode requires --provider, --model, --output-dir and --pi-cmd.");
  }
  if (values["--provider"] === "vercel-ai-gateway" && values["--model"] === "typesafe-ai/jev") {
    throw new Error("Jev evaluation needs a separate backend-specific comparison lane.");
  }
  const maxCalls = values["--max-calls"] === undefined ? HARD_CAP : Number(values["--max-calls"]);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > HARD_CAP) {
    throw new Error(`--max-calls must be an integer from 1 to ${HARD_CAP}.`);
  }
  return {
    provider: values["--provider"],
    model: values["--model"],
    outputDir: values["--output-dir"],
    piCmd: values["--pi-cmd"],
    maxCalls,
    baselineCommit: values["--baseline-commit"] ?? BASELINE_COMMIT,
    resume: flags.has("--resume"),
  };
}

export function createCallBudget(cap = HARD_CAP) {
  if (!Number.isInteger(cap) || cap < 1 || cap > HARD_CAP) throw new Error(`Call budget must be from 1 to ${HARD_CAP}.`);
  let made = 0;
  return {
    get made() { return made; },
    cap,
    charge() {
      if (made >= cap) {
        const error = new Error(`Live comparison hard cap of ${cap} reviewer calls reached.`);
        error.code = "hard-cap";
        throw error;
      }
      made += 1;
      return made;
    },
  };
}

/** Provider-reported usage only. Missing fields stay absent; callers store null when nothing was reported. */
export function providerUsage(reply) {
  const usage = reply?.usage;
  if (!usage || typeof usage !== "object") return null;
  const picked = {};
  for (const [source, target] of [["input", "input"], ["output", "output"], ["totalTokens", "totalTokens"]]) {
    const value = usage[source];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) picked[target] = value;
  }
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) picked.costUsd = cost;
  return Object.keys(picked).length ? picked : null;
}

/**
 * Terminal route shared by v2.3.0 and the candidate authorizer:
 * allow stays automatic; ordinary non-critical denial defers to the terminal;
 * critical or absolute denial blocks. This function never executes the action.
 */
export function terminalRoute(decision) {
  if (!decision || (decision.verdict !== "allow" && decision.verdict !== "deny")) {
    throw new Error("A reviewed decision needs an allow or deny verdict.");
  }
  if (decision.verdict === "allow") return { route: "allow", terminalPrompted: false, executorRan: false };
  if (decision.riskLevel !== "critical" && decision.absoluteDeny !== true) {
    return { route: "defer", terminalPrompted: true, executorRan: false };
  }
  return { route: "block", terminalPrompted: false, executorRan: false };
}

export function corpusDetails(item) {
  const name = item.action.name;
  const input = item.action.input;
  const facts = {
    version: 1,
    requestId: `corpus-${item.id}`,
    surface: name,
    value: JSON.stringify(input),
    action: {
      kind: name === "bash" ? "shell" : name === "read" || name === "write" ? "file" : "special",
      toolName: name,
      command: name === "bash" && typeof input.command === "string" ? input.command : null,
      path: typeof input.path === "string" ? input.path : null,
      target: typeof input.target === "string" ? input.target : typeof input.url === "string" ? input.url : null,
      input,
      mcp: null,
      authentication: { credentialPresent: false, valuesIncluded: false, mechanism: null },
    },
    cwd: null,
    accessIntent: null,
    policy: { state: "ask", source: name, origin: "builtin", matchedPattern: "*", reason: null },
    permissionDelta: { from: "ask", to: "allow_once", surface: name, value: JSON.stringify(input) },
    redactions: [],
    complete: true,
    missing: [],
    exactActionId: `corpus-${item.id}`,
  };
  return {
    requestId: facts.requestId,
    source: "tool_call",
    agentName: null,
    message: "Synthetic labeled corpus ask. Do not execute this action.",
    delegatedApproval: facts,
  };
}

export function caseIncludeToolResults(item, settings) {
  return item.config?.includeToolResults === false ? false : settings.includeToolResults !== false;
}

export function unavailableSample(index, code) {
  return { index, status: "unavailable", code, source: "live" };
}

export function reviewedSample(index, raw, decision, latencyMs, usage) {
  return {
    index,
    status: "reviewed",
    source: "live",
    raw: {
      verdict: raw.verdict,
      riskLevel: raw.riskLevel,
      userAuthorization: raw.userAuthorization,
      scope: raw.scope,
      absoluteDeny: raw.absoluteDeny,
    },
    final: terminalRoute(decision),
    latencyMs,
    usage: usage ?? null,
  };
}

export function publicFailureCode(outcome) {
  const code = outcome?.code;
  if (["auth", "cancelled", "evidence", "model", "parse", "timeout", "transport"].includes(code)) return code;
  if (outcome?.kind === "fact-request") return "transport";
  return "model";
}

/** Drop local filesystem locations before anything is written or printed. */
export function redactPaths(value) {
  return String(value)
    .replace(/[A-Za-z]:\\[^\s"']+/g, "<path>")
    .replace(/\/(?:Users|home)\/[^\s"']+/g, "<path>");
}
