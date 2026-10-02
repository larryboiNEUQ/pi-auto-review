#!/usr/bin/env node
// Real Pi extension-loader/RPC smoke. The model is a deterministic loopback
// fixture, so this proves plugin/runtime integration, not model judgement.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, symlink, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const options = { checkout: resolve(dirname(fileURLToPath(import.meta.url)), ".."), piRoot: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent", output: undefined, keep: false, peerRoot: undefined, expectBlocked: false, caseName: undefined };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--checkout") options.checkout = resolve(args[++i]);
  else if (args[i] === "--pi-root") options.piRoot = resolve(args[++i]);
  else if (args[i] === "--output") options.output = resolve(args[++i]);
  else if (args[i] === "--keep") options.keep = true;
  else if (args[i] === "--peer-root") options.peerRoot = resolve(args[++i]);
  else if (args[i] === "--expect-blocked") options.expectBlocked = true;
  else if (args[i] === "--case") {
    options.caseName = args[++i];
    if (!options.caseName) throw new Error("Missing --case name");
  }
  else throw new Error(`Unknown argument: ${args[i]}`);
}
const bundle = join(options.checkout, "index.js");
const entry = join(options.checkout, "pi-entry.ts");
const peerRoot = options.peerRoot ?? options.piRoot;
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const manifest = JSON.parse(await readFile(join(options.piRoot, "package.json"), "utf8"));
assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
const cli = existsSync(join(options.piRoot, "dist/bundle/cli.js")) ? join(options.piRoot, "dist/bundle/cli.js") : join(options.piRoot, "dist/cli.js");
assert.ok(existsSync(cli));
const workspace = await mkdtemp(join(tmpdir(), "pi-per-call-batches-"));
const initialBundleHash = await sha256(bundle);
const initialCliHash = await sha256(cli);
function hostDependencyRoot(packageRoot, dependency) {
 for (let current = packageRoot; ; current = dirname(current)) {
  const candidate = join(current, "node_modules", dependency);
  if (existsSync(candidate)) return candidate;
  if (dirname(current) === current) throw new Error(`Host dependency not found: ${dependency}`);
 }
}
// Native .js imports otherwise resolve the checkout's older devDependency.
// Load exactly the same bundle bytes with host peers from the chosen real Pi.
const extensionRoot = join(workspace, "package");
const loadedBundle = join(extensionRoot, "index.js");
const loadedEntry = join(extensionRoot, "pi-entry.ts");
await mkdir(extensionRoot, { recursive: true });
await copyFile(bundle, loadedBundle);
await copyFile(entry, loadedEntry);
await copyFile(join(options.checkout, "package.json"), join(extensionRoot, "package.json"));
for (const dependency of ["ai", "zod", "web-tree-sitter", "tree-sitter-bash", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-agent-core"]) {
 const destination = join(extensionRoot, "node_modules", dependency);
 const source = dependency === "@earendil-works/pi-coding-agent" ? peerRoot : dependency.startsWith("@earendil-works/") ? hostDependencyRoot(peerRoot, dependency) : join(options.checkout, "node_modules", dependency);
 assert.ok(existsSync(source), `Missing smoke dependency: ${source}`);
 await mkdir(dirname(destination), { recursive: true });
 await symlink(source, destination, "dir");
}
assert.equal(await sha256(loadedBundle), initialBundleHash);
const receipt = { piVersion: manifest.version, piRoot: options.piRoot, extensionPeerRoot: peerRoot, entry, entrySha256: await sha256(entry), cliSha256: initialCliHash, bundle, bundleSha256: initialBundleHash, cases: [], limits: ["The local provider returns fixed verdicts; no live model behaviour is claimed.", "These cases cover top-level RPC batches and an owned two-session RPC-parent/SDK-child forwarding path; third-party subagents and nested dispatch are not covered."] };

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
async function lines(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function timeout(promise, label, ms = 30_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); })]).finally(() => clearTimeout(timer));
}
function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
function sse(response, model, delta, finish = "stop") {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (payload) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, ...payload }] })}\n\n`;
  response.write(chunk({ delta, finish_reason: null }));
  response.write(chunk({ delta: {}, finish_reason: finish }));
  response.end("data: [DONE]\n\n");
}

function rpcDriver(argv, cwd, env) {
  const child = spawn(process.execPath, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const events = [];
  const replies = new Map();
  const ended = deferred();
  const abortRequested = deferred();
  let dialogs = 0;
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const command = async (value) => {
    const id = `command-${replies.size}-${Date.now()}`;
    const reply = deferred();
    replies.set(id, reply);
    send({ id, ...value });
    return timeout(reply.promise, value.type);
  };
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    if (event.type === "response") replies.get(event.id)?.resolve(event);
    if (event.type === "agent_end") ended.resolve();
    if (event.type === "abort_requested") abortRequested.resolve();
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) {
      dialogs++;
      send({ type: "extension_ui_response", id: event.id, cancelled: true });
    }
  });
  child.once("error", (error) => ended.reject(error));
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) ended.reject(new Error(`Pi exited ${code}: ${stderr.slice(-2000)}`));
    for (const reply of replies.values()) reply.reject(new Error(`Pi exited: ${stderr.slice(-2000)}`));
  });
  return { command, events, ended, abortRequested, get dialogs() { return dialogs; }, get stderr() { return stderr; }, stop() { reader.close(); child.kill("SIGTERM"); } };
}
async function requestWires(agentDir) {
  const root = join(agentDir, "sessions/permission-forwarding/sessions");
  if (!existsSync(root)) return [];
  const wires = [];
  for (const session of await readdir(root)) {
    const requests = join(root, session, "requests");
    if (!existsSync(requests)) continue;
    for (const file of await readdir(requests)) if (file.endsWith(".json")) wires.push(JSON.parse(await readFile(join(requests, file), "utf8")));
  }
  return wires;
}
async function runCase(name, verdicts, { abortAtSecondReview = false, forwarded = false, executionMode = "parallel" } = {}) {
  const callCount = verdicts.length;
  assert.ok(callCount > 0);
  assert.ok(["parallel", "sequential"].includes(executionMode));
  const cwd = join(extensionRoot, name);
  const agentDir = join(cwd, "agent");
  const markers = join(cwd, "executor.jsonl");
  const startedSecondReview = deferred();
  let reviewCount = 0;
  const reviewed = [];
  let heldResponse;
  const requests = [];
  const forwardedWires = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push({ model: payload.model, streaming: payload.stream });
      if (payload.model === "fixture-review") {
        const index = reviewCount++;
        if (forwarded) forwardedWires.push(...await requestWires(agentDir));
        reviewed.push({ index, verdict: verdicts[index] ?? "deny" });
        if (abortAtSecondReview && index === 1) {
          heldResponse = response;
          startedSecondReview.resolve();
          return;
        }
        const deny = verdicts[index] === "deny";
        sse(response, payload.model, { role: "assistant", content: JSON.stringify({ riskLevel: deny ? "critical" : "low", userAuthorization: "high", verdict: deny ? "deny" : "allow", rationale: `Controlled integration fixture ${index}`, scope: "narrow", absoluteDeny: deny }) });
      } else {
        if (payload.model === "fixture-parent") {
          sse(response, payload.model, { role: "assistant", content: "Ready to review the authorized child markers." });
          return;
        }
        assert.equal(payload.model, "fixture-task");
        const hasToolResult = payload.messages.some((message) => message.role === "tool");
        if (hasToolResult) sse(response, payload.model, { role: "assistant", content: "Fixture finished." });
        else sse(response, payload.model, { role: "assistant", tool_calls: verdicts.map((_, index) => ({ index, id: `sentinel-${index}`, type: "function", function: { name: "sentinel", arguments: JSON.stringify({ marker: `effect-${index}` }) } })) }, "tool_calls");
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const port = server.address().port;
  await mkdir(agentDir, { recursive: true });
  await json(join(agentDir, "settings.json"), { defaultProvider: "per-call-fixture", defaultModel: "fixture-task", defaultThinkingLevel: "off", compaction: { enabled: false }, cacheWarming: "off" });
  await json(join(agentDir, "extensions/pi-permission-system/config.json"), { permission: { "*": "ask", sentinel: "ask" }, permissionReviewLog: true, authorizerChain: ["safe-allow"] });
  await json(join(agentDir, "extensions/pi-permission-safe-allow/config.json"), { provider: "per-call-fixture", model: "fixture-review", timeoutMs: 20_000, maxAttempts: 1 });
  const fixture = join(cwd, "fixture.ts");
  await writeFile(fixture, `import { appendFileSync } from "node:fs";
import { VERSION } from "@earendil-works/pi-coding-agent";
export default function(pi) {
 pi.registerProvider("per-call-fixture", { baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/v1`)}, apiKey: "disposable-fixture-key", api: "openai-completions", models: ["fixture-task", "fixture-review", "fixture-parent"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192, compat: { supportsStore: false, supportsDeveloperRole: false } })) });
 pi.registerTool({ name: "sentinel", label: "Disposable sentinel", description: "Record one harmless local marker", executionMode: ${JSON.stringify(executionMode)}, parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false }, async execute(id, input, signal) { appendFileSync(${JSON.stringify(markers)}, JSON.stringify({ id, marker: input.marker, VERSION }) + "\\n"); return { content: [{ type: "text", text: "recorded " + input.marker }], details: {} }; } });
}`);
  const cliArgs = (model) => [cli, "--mode", "rpc", "--no-session", "--no-skills", "--no-context-files", "--no-prompt-templates", "--exclude-tools", "bash,read,write,edit,grep,find,ls,web_search,fetch_content,source_check,get_search_content", "--extension", loadedEntry, "--extension", fixture, "--provider", "per-call-fixture", "--model", model];
  const baseEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  let parent;
  let driver;
  if (forwarded) {
    parent = rpcDriver(cliArgs("fixture-parent"), cwd, baseEnv);
    const parentState = await parent.command({ type: "get_state" });
    assert.equal(parentState.success, true);
    await parent.command({ type: "prompt", message: `Authorize the named child to use exactly its ${callCount} disposable sentinel markers. No other effects are authorized.` });
    await timeout(parent.ended.promise, "parent authorization turn");
    const childCwd = join(cwd, "child");
    await json(join(childCwd, ".pi/extensions/pi-permission-safe-allow/config.json"), { disabled: true });
    const sdkDriver = join(cwd, "child-sdk.mjs");
    await writeFile(sdkDriver, `import { createInterface } from "node:readline";
+import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, VERSION } from ${JSON.stringify('file://' + join(options.piRoot, "dist/index.js"))};
+const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
+const modelRuntime = await ModelRuntime.create({ authPath: agentDir + "/auth.json", modelsPath: agentDir + "/models.json", refreshOnCreate: false });
+const settingsManager = SettingsManager.create(cwd, agentDir);
+const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [${JSON.stringify(loadedEntry)}, ${JSON.stringify(fixture)}], noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
+await loader.reload();
+if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
+const model = { id: "fixture-task", name: "fixture-task", api: "openai-completions", provider: "per-call-fixture", baseUrl: ${JSON.stringify(`http://127.0.0.1:${port}/v1`)}, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
+const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(cwd), tools: ["sentinel"] });
+await session.bindExtensions({ mode: "json", onError: (event) => console.error(JSON.stringify(event)) });
+session.subscribe(event => console.log(JSON.stringify(event)));
+createInterface({ input: process.stdin }).on("line", async line => { const command = JSON.parse(line); try { let data = {}; if (command.type === "get_state") data = { sessionId: session.sessionManager.getSessionId(), VERSION }; else if (command.type === "prompt") { void session.prompt(command.message).catch(error => console.error(String(error))); } else if (command.type === "abort") { const operation = session.abort(); console.log(JSON.stringify({ type: "abort_requested" })); await operation; } console.log(JSON.stringify({ type: "response", id: command.id, success: true, data })); } catch (error) { console.log(JSON.stringify({ type: "response", id: command.id, success: false, error: String(error) })); } });
+`.replaceAll("\n+", "\n"));
    driver = rpcDriver([sdkDriver], childCwd, { ...baseEnv, PI_IS_SUBAGENT: "1", PI_SUBAGENT_PARENT_SESSION: parentState.data.sessionId });
  } else driver = rpcDriver(cliArgs("fixture-task"), cwd, baseEnv);
  try {
    const ready = await driver.command({ type: "get_state" });
    assert.equal(ready.success, true, driver.stderr);
    const prompted = await driver.command({ type: "prompt", message: `Use the ${callCount} disposable sentinel markers authorized for this controlled integration trial. No other effects are authorized.` });
    assert.equal(prompted.success, true, JSON.stringify(prompted));
    if (abortAtSecondReview) {
      await timeout(startedSecondReview.promise, "second real review request");
      assert.deepEqual((await lines(markers)).map(({ marker }) => marker), executionMode === "sequential" ? ["effect-0"] : [], "Sequential dispatch finishes A before reviewing B; parallel dispatch prepares the entire batch first");
      const stop = driver.command({ type: "abort" });
      if (forwarded) {
        await timeout(driver.abortRequested.promise, "child abort signal");
        // The parent may still finish its review; a late allow must not execute
        // any unstarted child call. A completed sequential call stays completed.
        sse(heldResponse, "fixture-review", { role: "assistant", content: JSON.stringify({ riskLevel: "low", userAuthorization: "high", verdict: "allow", rationale: "Late parent allow after child abort", scope: "narrow", absoluteDeny: false }) });
      }
      const stopped = await stop;
      assert.equal(stopped.success, true, JSON.stringify(stopped));
      heldResponse?.destroy();
    }
    await timeout(driver.ended.promise, `${name} agent_end`);
    const effects = await lines(markers);
    const expectedMarkers = options.expectBlocked ? [] : abortAtSecondReview ? executionMode === "sequential" ? ["effect-0"] : [] : verdicts.flatMap((verdict, index) => verdict === "allow" ? [`effect-${index}`] : []);
    assert.deepEqual(effects.map((effect) => effect.marker), expectedMarkers, "Sibling hard denials must not cancel approved calls; explicit stop only prevents unstarted effects");
    for (const effect of effects) assert.equal(effect.VERSION, manifest.version, "executor must run in the actual requested Pi runtime");
    const expectedReviews = options.expectBlocked ? 0 : abortAtSecondReview ? 2 : callCount;
    assert.equal(reviewCount, expectedReviews, `Every ask before explicit stop must reach the real reviewer provider: ${driver.stderr}`);
    assert.equal(driver.dialogs + (parent?.dialogs ?? 0), 0, "This smoke must never pass by approving a native dialog");
    const audit = await lines(join(agentDir, "extensions/pi-permission-safe-allow/logs/safe-allow.jsonl"));
    const decisions = audit.filter((event) => event.event === "review.decision");
    assert.equal(decisions.length, options.expectBlocked ? 0 : abortAtSecondReview && !forwarded ? 1 : expectedReviews, `Unexpected reviewer decisions: ${JSON.stringify(audit)}`);
    const circuitBreakers = audit.filter((event) => event.event === "denial.circuit_breaker");
    assert.equal(circuitBreakers.length, 0, "Proven supported batch refusals must never automatically stop the owning agent");
    for (const decision of decisions) assert.equal(decision.circuitBreaker ?? null, null, "Batch refusals must not accumulate toward a turn-wide circuit breaker");
    const blocked = audit.filter((event) => event.code === "batch_release_unfenced");
    if (options.expectBlocked) {
      assert.equal(blocked.length, callCount, "Unsupported actual host must block every ask before inference");
      for (const event of blocked) assert.equal(event.hostVersion, manifest.version, "Decision must use actual executor host, even when extension peers differ");
    } else assert.equal(blocked.length, 0, "Supported host must not fail the batch fence gate");
    for (const decision of decisions) {
      assert.equal(decision.hostVersion, manifest.version, "Reviewer audit must use actual executor host");
      assert.equal(decision.batchProvenance, "multiple", "Isolation must be proven for a real multi-call batch");
      assert.equal(decision.approvalMode, "per_call", "Supported batch admission must retain per-call approvals");
    }
    const provenance = audit.filter((event) => event.event === "runtime.provenance");
    assert.ok(provenance.length, "Loaded bundle must publish runtime provenance");
    if (forwarded) {
      assert.equal(forwardedWires.length, expectedReviews, "Every reviewed child ask must use real parent forwarding");
      for (const wire of forwardedWires) { assert.equal(wire.hostVersion, manifest.version); assert.equal(wire.batchProvenance, "multiple"); }
    }
    receipt.cases.push({ name, forwarded, executionMode, callCount, forwardedWires, pass: true, reviewCount, reviewed, blocked, circuitBreakers, decisions: decisions.map(({ verdict, actionId, policyVersion, hostVersion, batchProvenance, approvalMode, circuitBreaker }) => ({ verdict, actionId, policyVersion, hostVersion, batchProvenance, approvalMode, circuitBreaker })), markers: effects, nativeDialogs: driver.dialogs + (parent?.dialogs ?? 0), runtimeProvenance: provenance, requestModels: requests.map(({ model }) => model), toolResults: driver.events.filter((event) => event.type === "tool_execution_end").map(({ toolCallId, isError, result }) => ({ toolCallId, isError, result })) });
  } catch (error) {
    await json(join(cwd, "failure.json"), { name, forwarded, executionMode, verdicts, reviewCount, reviewed, markers: await lines(markers), error: String(error), stderr: driver.stderr, events: driver.events, audit: await lines(join(agentDir, "extensions/pi-permission-safe-allow/logs/safe-allow.jsonl")) });
    error.message += `; evidence: ${cwd}/failure.json`;
    options.keep = true;
    throw error;
  } finally {
    driver.stop();
    parent?.stop();
    heldResponse?.destroy();
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

const cases = [
  { name: "all-allow", verdicts: ["allow", "allow"] },
  ...(options.expectBlocked ? [] : [
    { name: "mixed-allow-deny", verdicts: ["allow", "deny"] },
    { name: "abort-waiting-review", verdicts: ["allow", "allow"], abortAtSecondReview: true },
    { name: "forwarded-all-allow", verdicts: ["allow", "allow"], forwarded: true },
    { name: "forwarded-mixed-allow-deny", verdicts: ["allow", "deny"], forwarded: true },
    { name: "forwarded-abort-waiting-review", verdicts: ["allow", "allow"], abortAtSecondReview: true, forwarded: true },
    // Both orderings catch the breaker bug: parallel preparation can suppress
    // an earlier approved A; sequential dispatch can skip a later approved D.
    ...["parallel", "sequential"].flatMap((executionMode) => [false, true].flatMap((forwarded) => [
      { name: `${forwarded ? "forwarded-" : ""}${executionMode}-allow-then-three-hard-denials`, verdicts: ["allow", "deny", "deny", "deny"], executionMode, forwarded },
      { name: `${forwarded ? "forwarded-" : ""}${executionMode}-three-hard-denials-then-allow`, verdicts: ["deny", "deny", "deny", "allow"], executionMode, forwarded },
    ])),
    { name: "sequential-abort-waiting-review", verdicts: ["allow", "allow"], executionMode: "sequential", abortAtSecondReview: true },
    { name: "forwarded-sequential-abort-waiting-review", verdicts: ["allow", "allow"], executionMode: "sequential", abortAtSecondReview: true, forwarded: true },
  ]),
];
const selectedCases = options.caseName ? cases.filter(({ name }) => name === options.caseName) : cases;
try {
  assert.ok(selectedCases.length, `Unknown or unavailable case: ${options.caseName}`);
  for (const { name, verdicts, ...configuration } of selectedCases) await runCase(name, verdicts, configuration);
  assert.equal(await sha256(cli), initialCliHash, "Smoke must not patch Pi");
  assert.equal(await sha256(loadedEntry), receipt.entrySha256, "Smoke must use one unchanged entry");
  assert.equal(await sha256(bundle), initialBundleHash, "Smoke must use one unchanged bundle");
  if (options.output) await json(options.output, receipt);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (options.keep) console.error(`Disposable smoke directory retained: ${workspace}`);
  else await rm(workspace, { recursive: true, force: true });
}
