import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("./jev-live.mjs", import.meta.url));

test("Jev live runner refuses paid inference without explicit opt-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-live-opt-in-"));
  try {
    assert.throws(() => execFileSync(process.execPath, [runner, "auto", "1", dir], {
      env: { ...process.env, SAFE_ALLOW_JEV_LIVE: "" },
      stdio: "pipe",
    }), /Set SAFE_ALLOW_JEV_LIVE=1/);
    assert.equal(existsSync(join(dir, "jev-auto.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
