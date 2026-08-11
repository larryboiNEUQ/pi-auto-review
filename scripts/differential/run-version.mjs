#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CASES = [
  { id: "bundle-read", tool: "read", input: (cwd) => ({ path: join(cwd, "file.txt") }) },
  { id: "bash-pwd", tool: "bash", input: () => ({ command: "pwd" }) },
  { id: "protected-secret", tool: "read", input: (cwd) => ({ path: join(cwd, ".env.production") }) },
];

function makeEventBus(decisions) {
  const listeners = new Map();
  return {
    on(channel, listener) {
      const channelListeners = listeners.get(channel) ?? [];
      channelListeners.push(listener);
      listeners.set(channel, channelListeners);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== listener));
    },
    emit(channel, data) {
      if (channel === "permissions:decision") decisions.push(data);
      for (const listener of listeners.get(channel) ?? []) listener(data);
    },
  };
}

function normalizeValue(value, cwd) {
  if (typeof value !== "string") return value;
  const rel = relative(cwd, value);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`))) {
    return rel ? `<CWD>/${rel.split(sep).join("/")}` : "<CWD>";
  }
  return value.split(sep).join("/");
}

async function observeSafeAllowAudit(agentDir) {
  const selected = [
    "extension_loaded",
    "permissions_ready",
    "session_start",
    "review.routed",
    "review.decision",
    "review.failure",
    "probe.completed",
  ];
  const counts = Object.fromEntries(selected.map((event) => [event, 0]));
  let modelAttempts = 0;
  const path = join(agentDir, "extensions", "pi-permission-safe-allow", "logs", "safe-allow.jsonl");
  let text;
  try { text = await readFile(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return { counts, modelAttempts };
    throw error;
  }
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line);
    if (Object.hasOwn(counts, record.event)) counts[record.event] += 1;
    if (record.event === "review.decision" && typeof record.attempts === "number" && Number.isFinite(record.attempts)) {
      modelAttempts += record.attempts;
    }
  }
  return { counts, modelAttempts };
}

async function main() {
  const [entryArg, ref, commit, output] = process.argv.slice(2);
  if (!entryArg || !ref || !commit || !output) throw new Error("Usage: run-version.mjs ENTRY REF COMMIT OUTPUT");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error(`commit must be a full hexadecimal commit SHA (received ${commit})`);
  }

  const root = await mkdtemp(join(tmpdir(), "pi-release-differential-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_SAFE_ALLOW_VERBOSE = "0";
    const configPath = join(agentDir, "extensions", "pi-permission-system", "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({ authorizerChain: [], permission: { "*": "ask", path: { "*": "allow" }, read: "allow", write: "allow", bash: { "*": "ask", pwd: "allow" } } }, null, 2)}\n`);

    const decisions = [];
    const handlers = new Map();
    const events = makeEventBus(decisions);
    const tools = ["read", "write", "bash"];
    const pi = {
      events,
      on(name, handler) { const entries = handlers.get(name) ?? []; entries.push(handler); handlers.set(name, entries); },
      registerCommand() {}, registerProvider() {}, exec() {},
      getAllTools() { return tools.map((name) => ({ name })); },
      getActiveTools() { return [...tools]; },
      setActiveTools() {},
    };
    const extension = (await import(`${pathToFileURL(entryArg).href}?run=${encodeURIComponent(commit)}`)).default;
    if (typeof extension !== "function") throw new Error(`${entryArg} has no default extension factory`);
    extension(pi);
    const ctx = {
      cwd, hasUI: true, modelRegistry: { find: () => undefined },
      ui: { notify() {}, setStatus() {}, select: async () => "No", input: async () => undefined },
      sessionManager: { getEntries: () => [], getSessionId: () => "differential-session", getSessionDir: () => join(root, "session"), addEntry() {} },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "start" }, ctx);
    const caseResults = [];
    for (const testCase of CASES) {
      decisions.length = 0;
      let toolCallResult;
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolCallId: `differential-${testCase.id}`, name: testCase.tool, input: testCase.input(cwd) }, ctx);
        if (result !== undefined) toolCallResult = result;
      }
      caseResults.push({ id: testCase.id, toolCallResult: toolCallResult ?? null, decisions: decisions.map((decision) => ({ ...decision, value: normalizeValue(decision.value, cwd) })) });
    }
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    const { counts: safeAllowJsonlCounts, modelAttempts } = await observeSafeAllowAudit(agentDir);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({ ref, commit, cases: caseResults, safeAllowJsonlCounts, modelAttempts }, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
