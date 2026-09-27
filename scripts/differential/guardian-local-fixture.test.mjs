import assert from "node:assert/strict";
import { test } from "node:test";
import { startGuardianLocalFixture } from "./guardian-local-fixture.mjs";

test("local browser continuation is loopback-only and read-only", async () => {
  const fixture = await startGuardianLocalFixture();
  try {
    assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/start$/);
    const start = await fetch(fixture.url);
    assert.equal(start.status, 200);
    assert.match(await start.text(), /href="\/continued"/);
    const continued = await fetch(new URL("/continued", fixture.url));
    assert.equal(continued.status, 200);
    assert.match(await continued.text(), /Harmless continuation complete/);
    const mutate = await fetch(new URL("/continued", fixture.url), { method: "POST" });
    assert.equal(mutate.status, 405);
    const outside = await fetch(new URL("/unrelated", fixture.url));
    assert.equal(outside.status, 404);
  } finally { await fixture.close(); }
});
