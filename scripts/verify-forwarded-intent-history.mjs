// Read-only Issue #43 diagnosis against fixed historical Git objects.
// No inference, configuration writes, or requested shell commands are executed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const authority = "packages/pi-permission-system/src/authority/";
const fixture = {
  id: "offline-diagnosis",
  requesterAgentName: "worker",
  requesterSessionId: "child",
  surface: "bash",
  value: "git status",
  message: "Offline fixture: never execute this action",
  accessIntent: {
    surface: "bash",
    matchValues: ["git status"],
    boundaryValue: null,
    requesterCwd: "/example/child-worktree",
    principal: { sessionId: "child", agentName: "worker" },
  },
};

function historicalFile(ref, path) {
  return execFileSync("git", ["-C", root, "show", `${ref}:${path}`], {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
}

// Extract the actual pure functions, not a reimplementation of their behavior.
function sourceFunctions(ref, filename, names) {
  const source = ts.createSourceFile(
    filename,
    historicalFile(ref, authority + filename),
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = source.statements.filter((statement) =>
    names
      ? ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)
      : ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement),
  );
  if (names) assert.equal(selected.length, names.length);
  const javascript = ts.transpileModule(
    selected.map((statement) => statement.getText(source)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return new Function(
    "exports",
    `${javascript}\nreturn {${(names ?? ["encloseInDelegationEnvelope"]).join(",")}};`,
  )({});
}

async function verifySource(ref, expected) {
  const { buildForwardedAskDetails } = sourceFunctions(
    ref,
    "forwarded-request-server.ts",
    ["formatForwardedPermissionPrompt", "buildForwardedAskDetails"],
  );
  const { encloseInDelegationEnvelope } = sourceFunctions(ref, "delegation-envelope.ts");
  const details = buildForwardedAskDetails(fixture);
  assert.equal(details.accessIntent, undefined);
  const reviewer = encloseInDelegationEnvelope(async () => ({ kind: "allow" }));
  assert.equal((await reviewer(details, {})).kind, expected);
  assert.equal((await reviewer({ ...details, accessIntent: fixture.accessIntent }, {})).kind, "allow");
  console.log(`source ${ref}: fixed reviewer allow -> ${expected}; preserved-facts control -> allow`);
}

function only(nodes, predicate, label) {
  const found = nodes.filter(predicate);
  assert.equal(found.length, 1, `Historical bundle shape changed: ${label}`);
  return found[0];
}

function verifyBundle(ref) {
  const source = ts.createSourceFile("index.js", historicalFile(ref, "index.js"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  const text = (node) => node.getText(source);
  const mapper = only(functions, (node) => {
    const body = text(node);
    return body.includes("forwarding:") && body.includes("sessionApproval:") && body.includes("requestId:") && body.length < 1800;
  }, "forwarded ask mapper");
  const formatter = only(functions, (node) => text(node).includes("Session ID:") && text(node).includes("Subagent"), "forwarded prompt formatter");
  const cap = only(functions, (node) => text(node).includes(".accessIntent?.surface") && text(node).length < 500, "delegation cap");
  const setName = text(cap).match(/([A-Za-z_$][\w$]*)\.has\(/)?.[1];
  assert.ok(setName, "Historical cap must retain its excluded-surface set");
  const variables = source.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
  const excluded = only(variables, (node) => node.name.getText(source) === setName, "excluded surfaces");
  const { map, isCapped } = new Function(
    `${text(formatter)};${text(mapper)};var ${text(excluded)};${text(cap)};return {map:${mapper.name.text},isCapped:${cap.name.text}};`,
  )();
  const details = map(fixture);
  assert.equal(details.accessIntent, undefined);
  for (const mode of ["cap-allow", "honor-reviewer"]) {
    assert.equal(isCapped(details, mode), true);
    assert.equal(isCapped({ ...details, accessIntent: fixture.accessIntent }, mode), false);
  }
  console.log(`bundle ${ref}: missing facts capped in both modes; preserved-facts control not capped`);
}

for (const ref of ["v2.1.0", "v2.2.0", "e3445d1"]) {
  await verifySource(ref, "defer");
  verifyBundle(ref);
}
await verifySource("f0b76b1^", "allow");
await verifySource("f0b76b1", "defer");
console.log("PASS: fixed-revision source/bundle attribution; no live actions or configuration changes.");
