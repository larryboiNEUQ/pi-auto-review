import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import type { DenialRecord } from "./denial-lifecycle";
import { redactSecrets } from "./redaction";

export const APPROVAL_OPTION_MAX_COLUMNS = 160;
const CUE_MAX = 48;
const PREVIEW_MAX = 76;

export interface ApprovalPickerOption {
  label: string;
  denialId?: string;
  bulkDenialIds?: readonly string[];
}

function clean(value: unknown): string {
  return String(redactSecrets(String(value ?? "")))
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayColumns(value: string): number {
  return [...value].reduce(
    (total, char) => total + (char.codePointAt(0)! <= 0x7f ? 1 : 2),
    0,
  );
}

function takeColumns(value: string, budget: number, fromEnd = false): string {
  const chars = [...value];
  if (fromEnd) chars.reverse();
  const kept: string[] = [];
  let used = 0;
  for (const char of chars) {
    const width = char.codePointAt(0)! <= 0x7f ? 1 : 2;
    if (used + width > budget) break;
    kept.push(char);
    used += width;
  }
  if (fromEnd) kept.reverse();
  return kept.join("");
}

function bounded(value: string, max: number): string {
  if (displayColumns(value) <= max) return value;
  const end = Math.max(10, Math.floor(max * 0.4));
  return `${takeColumns(value, max - end - 1)}…${takeColumns(value, end, true)}`;
}

function rationaleCue(value: string): string {
  const safe = clean(value).replaceAll("[REDACTED_SECRET]", "[SECRET]");
  const sentence = safe.match(/^.*?(?:[.!?](?:\s|$)|$)/)?.[0] ?? safe;
  const cue = sentence.trim();
  return (displayColumns(cue) > CUE_MAX ? `${takeColumns(cue, CUE_MAX - 1)}…` : cue) || "reviewer denied";
}

function abbreviatePath(value: string, cwd: string): string {
  const safe = clean(value);
  if (!safe) return "unknown target";
  const home = homedir();
  let shown = safe;
  if (isAbsolute(safe) && cwd) {
    const rel = relative(resolve(cwd), resolve(safe));
    if (rel === "") shown = ".";
    else if (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      shown = `./${rel}`;
    }
  }
  if (shown === safe && (safe === home || safe.startsWith(`${home}/`))) {
    shown = `~${safe.slice(home.length)}`;
  }
  return bounded(shown, PREVIEW_MAX);
}

interface ShellParts { parts: string[]; certain: boolean }

function splitLiteralShell(command: string): ShellParts {
  const parts: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    const pair = command.slice(i, i + 2);
    if (char === ";" || pair === "&&" || pair === "||") {
      const part = command.slice(start, i).trim();
      if (!part) return { parts: [], certain: false };
      parts.push(part);
      i += pair.length === 2 ? 1 : 0;
      start = i + 1;
    }
  }
  const last = command.slice(start).trim();
  if (quote || escaped || !last || /(?:\$\(|`|\n|\r)/.test(command)) {
    return { parts: [], certain: false };
  }
  parts.push(last);
  return { parts, certain: true };
}

const CONSEQUENTIAL = /^(?:sudo\s+)?(?:git\s+(?:commit|push|merge|rebase|reset)|npm\s+(?:publish|deploy)|pnpm\s+(?:publish|deploy)|yarn\s+(?:publish|deploy)|rm\b|curl\b|wget\b|ssh\b|scp\b|docker\s+(?:push|rm)|kubectl\s+(?:apply|delete)|gh\s+(?:pr|release|workflow))/i;

function shellPreview(command: string | null, cwd: string): string {
  const raw = String(redactSecrets(command ?? ""));
  const safe = clean(raw);
  if (!safe) return "opaque shell action";
  if (/[\r\n]/.test(raw) || /\$(?:[{(]|[A-Za-z_])|`/.test(raw)) {
    return bounded(safe, PREVIEW_MAX);
  }
  const parsed = splitLiteralShell(safe);
  if (!parsed.certain || parsed.parts.length === 1) return bounded(safe, PREVIEW_MAX);
  const useful = parsed.parts.filter((part) => !/^cd(?:\s|$)/.test(part));
  const consequential = useful.filter((part) => CONSEQUENTIAL.test(part));
  const selected = (consequential.length ? consequential : useful).slice(-2);
  if (selected.length === 0) return bounded(safe, PREVIEW_MAX);
  const omitted = parsed.parts.length - selected.length;
  const cue = selected.map((part) => {
    const cwdPrefix = cwd ? `${cwd.replace(/\/$/, "")}/` : "";
    return bounded(clean(part).replaceAll(cwdPrefix, "./"), 48);
  }).join(" → ");
  return bounded(`${cue}${omitted > 0 ? ` (+${omitted} steps)` : ""}`, PREVIEW_MAX);
}

function actionPreview(denial: DenialRecord, cwd: string): string {
  const { action } = denial.action;
  switch (action.kind) {
    case "shell": return shellPreview(action.command, denial.action.cwd ?? cwd);
    case "file": return `${clean(denial.action.surface)} ${abbreviatePath(action.path ?? action.target ?? denial.action.value, cwd)}`;
    case "external_path": return abbreviatePath(action.path ?? action.target ?? denial.action.value, cwd);
    case "mcp": return bounded(`${clean(action.mcp?.server ?? "unknown-server")}/${clean(action.mcp?.tool ?? action.target ?? "unknown-tool")}`, PREVIEW_MAX);
    case "network": {
      const target = clean(action.target ?? denial.action.value);
      try { return bounded(new URL(target).host || target, PREVIEW_MAX); } catch { return bounded(target, PREVIEW_MAX); }
    }
    case "permission": return bounded(`${clean(denial.action.surface)} ${clean(action.target ?? denial.action.value)}`, PREVIEW_MAX);
    case "skill": return bounded(clean(action.target ?? denial.action.value), PREVIEW_MAX);
    default: return bounded(clean(action.target ?? action.path ?? denial.action.value), PREVIEW_MAX);
  }
}

function kindLabel(denial: DenialRecord): string {
  const kind = denial.action.action.kind;
  if (kind === "external_path") return "Path";
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function buildApprovalPickerOptions(
  denials: readonly DenialRecord[],
  cwd: string,
): ApprovalPickerOption[] {
  const options: ApprovalPickerOption[] = denials.map((denial, index) => {
    const prefix = `#${index + 1} [${denial.riskLevel.toUpperCase()}] ${kindLabel(denial)}`;
    const label = bounded(
      `${prefix} — ${rationaleCue(denial.rationale)} — ${actionPreview(denial, cwd)}`,
      APPROVAL_OPTION_MAX_COLUMNS,
    );
    return { label, denialId: denial.denialId };
  });

  const unique = new Map<string, DenialRecord>();
  for (const denial of denials) {
    if (!unique.has(denial.exactActionId)) unique.set(denial.exactActionId, denial);
  }
  if (unique.size >= 2) {
    options.push({
      label: `──────── Approve all shown (${unique.size} exact retries)`,
      bulkDenialIds: [...unique.values()].map((denial) => denial.denialId),
    });
  }
  return options;
}
