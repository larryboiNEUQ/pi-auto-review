import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const GROUPS = ["routine", "protected", "uncertain"];
const TOOLS = new Set(["browser_action", "bash", "read", "write"]);
const ENTRY_TYPES = new Set(["message", "compaction", "context_edit"]);
const own = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate a fixed, inert comparison corpus; this function never executes actions. */
export function validateGuardianCorpus(cases) {
  if (!Array.isArray(cases) || cases.length !== 24) throw new Error("Guardian corpus must have exactly 24 cases.");
  const seen = new Set();
  const counts = Object.fromEntries(GROUPS.map(group => [group, 0]));
  for (const item of cases) {
    if (!own(item) || typeof item.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(item.id)) throw new Error("Malformed corpus ID.");
    if (seen.has(item.id)) throw new Error(`Duplicate corpus ID: ${item.id}`);
    seen.add(item.id);
    if (!GROUPS.includes(item.group)) throw new Error(`Unknown group for ${item.id}.`);
    counts[item.group]++;
    if (item.expectedAutomatic !== (item.group === "routine" ? "allow" : "not-allow")) throw new Error(`Unsafe expected-automatic label for ${item.id}.`);
    if (typeof item.rationale !== "string" || !item.rationale.trim()) throw new Error(`Missing rationale for ${item.id}.`);
    if (!own(item.action) || !TOOLS.has(item.action.name) || !own(item.action.input)) throw new Error(`Unknown or malformed action for ${item.id}.`);
    if (!Array.isArray(item.entries) || item.entries.length === 0 || item.entries.length > 100 ||
      !item.entries.every(entry => own(entry) && ENTRY_TYPES.has(entry.type)) ||
      !item.entries.some(entry => entry.type === "message" && entry.message?.role === "user")) throw new Error(`Missing or malformed entries for ${item.id}.`);
    const last = item.entries.at(-1);
    const content = last?.message?.content;
    const calls = Array.isArray(content) ? content.filter(part => part?.type === "toolCall") : [];
    const pending = calls[0];
    if (last?.type !== "message" || last.message?.role !== "assistant" || calls.length !== 1 ||
        typeof pending.id !== "string" || !pending.id || pending.name !== item.action.name ||
        !isDeepStrictEqual(pending.arguments, item.action.input) ||
        item.entries.slice(0, -1).some(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === pending.id ||
          entry.message?.role === "assistant" && entry.message.content?.some?.(part => part.type === "toolCall" && part.id === pending.id))) {
      throw new Error(`Current pending call is missing, completed or inconsistent for ${item.id}.`);
    }
    if (item.config !== undefined && (!own(item.config) || Object.keys(item.config).length !== 1 || item.config.includeToolResults !== false)) throw new Error(`Unsupported config for ${item.id}.`);
    if (JSON.stringify(item).length > 50_000) throw new Error(`Case exceeds fixed size cap: ${item.id}.`);
  }
  if (GROUPS.some(group => counts[group] !== 8)) throw new Error("Guardian corpus must include eight cases in each group.");
  return cases;
}

export async function loadGuardianCorpus(path) {
  return validateGuardianCorpus(JSON.parse(await readFile(path, "utf8")));
}
