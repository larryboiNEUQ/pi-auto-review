import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runner = fileURLToPath(new URL("run-version.mjs", import.meta.url));
const fullCommit = "b1819950027665d87e690e9a82560d5213967799";

test("rejects a malformed resolved commit before loading the bundle", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [runner, join(tmpdir(), "missing-index.js"), "v2.0.0", "not-a-commit", join(tmpdir(), "unused-results.json")]),
    (error) => {
      assert.match(error.stderr, /commit must be a full hexadecimal commit SHA/);
      return true;
    },
  );
});

test("removes its temporary root when isolated bundle loading fails", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-release-differential-test-"));
  const env = { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox };
  try {
    await assert.rejects(execFileAsync(
      process.execPath,
      [runner, join(sandbox, "missing-index.js"), "v2.0.0", fullCommit, join(sandbox, "unused-results.json")],
      { env },
    ));
    assert.deepEqual(await readdir(sandbox), []);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("reports model attempts by summing public review.decision audit records", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-release-model-attempts-test-"));
  const entry = join(sandbox, "index.mjs");
  const output = join(sandbox, "results.json");
  await writeFile(entry, `
    import { appendFileSync, mkdirSync } from "node:fs";
    import { dirname, join } from "node:path";
    export default function (pi) {
      pi.on("session_start", () => {
        const path = join(process.env.PI_CODING_AGENT_DIR, "extensions", "pi-permission-safe-allow", "logs", "safe-allow.jsonl");
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify({ event: "review.decision", attempts: 2 }) + "\\n");
        appendFileSync(path, JSON.stringify({ event: "review.decision", attempts: 3 }) + "\\n");
      });
    }
  `);
  try {
    await execFileAsync(process.execPath, [runner, entry, "v2.0.0", fullCommit, output]);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.modelAttempts, 5);
    assert.equal(result.safeAllowJsonlCounts["review.decision"], 2);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
