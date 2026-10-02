import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGuardianCorpus } from "./guardian-corpus.mjs";

const corpusPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/pi-permission-safe-allow/evaluation/corpus-v1.json");

test("the fixed Guardian corpus has 24 uniquely labeled inert cases in three equal groups", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  const validated = validateGuardianCorpus(cases);
  assert.equal(validated.length, 24);
  assert.deepEqual(Object.fromEntries(["routine", "protected", "uncertain"].map(group =>
    [group, validated.filter(item => item.group === group).length])),
  { routine: 8, protected: 8, uncertain: 8 });
  assert.equal(validated.every(item => item.group === "routine" ? item.expectedAutomatic === "allow" : item.expectedAutomatic === "not-allow"), true);
});

test("corpus validation refuses duplicated IDs and label drift", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  const duplicate = structuredClone(cases);
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => validateGuardianCorpus(duplicate), /duplicate/i);
  const drift = structuredClone(cases);
  drift.find(item => item.group === "protected").expectedAutomatic = "allow";
  assert.throws(() => validateGuardianCorpus(drift), /label/i);
});

test("corpus validation refuses executable-looking or incomplete records", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  const malformed = structuredClone(cases);
  malformed[0].action = { name: "shell.exec", input: { command: "id" } };
  assert.throws(() => validateGuardianCorpus(malformed), /action/i);
  const missing = structuredClone(cases);
  missing[0].entries = [];
  assert.throws(() => validateGuardianCorpus(missing), /entries/i);
});

test("the current pending call is the final assistant entry, never an already-completed result", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  validateGuardianCorpus(cases);
  const mismatched = structuredClone(cases);
  mismatched[0].entries.at(-1).message.content[0].arguments = { action: "unrelated" };
  assert.throws(() => validateGuardianCorpus(mismatched), /pending/i);
});

test("provenance-loss labels correspond to actual host compaction and context edits", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  const compacted = cases.find(item => item.id === "uncertain-compacted-authorization");
  const edited = cases.find(item => item.id === "uncertain-context-edit-revocation");
  assert.equal(compacted.entries.some(entry => entry.type === "compaction" && entry.firstKeptEntryId), true);
  assert.equal(edited.entries.some(entry => entry.type === "context_edit" && entry.targetId && entry.replacement === null), true);
});

test("a stale-handle not-allow label has a concrete consequential effect, not draft uncertainty alone", async () => {
  const cases = JSON.parse(await readFile(corpusPath, "utf8"));
  const stale = cases.find(item => item.id === "uncertain-stale-closed-target");
  assert.equal(stale.action.input.target, "publish");
  assert.match(stale.entries.find(entry => entry.message?.role === "user").message.content[0].text, /do not publish/i);
});
