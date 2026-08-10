import { z } from "zod";

/**
 * Single source of truth for the permission-system config file shape.
 *
 * These composable zod schemas drive two consumers:
 * 1. Runtime validation in the config-file loader (`config-loader.ts`).
 * 2. The published JSON Schema (`schemas/permissions.schema.json`), derived by
 *    `buildPermissionsJsonSchema()` and regenerated via `pnpm run gen:schema`.
 *
 * Edit the schemas here — never the generated JSON by hand. A parity test
 * (`config-schema.test.ts`) fails if the committed JSON drifts from this source.
 */

/** Canonical hosted location of the generated JSON Schema (monorepo raw path). */
export const PERMISSIONS_SCHEMA_URL =
  "https://raw.githubusercontent.com/gotgenes/pi-packages/main/packages/pi-permission-system/schemas/permissions.schema.json";

const permissionStateSchema = z
  .union([
    z.literal("allow").meta({
      description: "Permit the action silently with no user interaction.",
    }),
    z.literal("deny").meta({
      description:
        "Block the action with an error message. The agent is told not to retry.",
    }),
    z.literal("ask").meta({
      description:
        "Prompt the user for confirmation via the interactive UI before proceeding.",
    }),
  ])
  .meta({
    id: "permissionState",
    description:
      "A permission decision: allow (permit silently), deny (block with error), or ask (prompt the user for confirmation).",
  });

const denyWithReasonSchema = z
  .strictObject({
    action: z.literal("deny").meta({
      description: 'The permission decision — must be "deny".',
    }),
    reason: z.string().max(500).optional().meta({
      description:
        "Optional reason shown to the agent when this action is denied.",
    }),
  })
  .meta({
    id: "denyWithReason",
    description:
      "Deny with an optional custom reason shown to the agent when the action is blocked.",
  });

const patternValueSchema = z.union([
  permissionStateSchema,
  denyWithReasonSchema,
]);

const permissionMapSchema = z
  .record(
    z.string().min(1).meta({
      description:
        "A non-empty pattern string. Use * for wildcard matching. Prefix with ~/ or $HOME/ for home-relative paths.",
    }),
    patternValueSchema,
  )
  .meta({
    id: "permissionMap",
    description:
      "A map of wildcard patterns to permission states. Last matching pattern wins.",
    markdownDescription:
      "A map of wildcard patterns to permission states.\n\nUse `*` for wildcard matching. When multiple patterns match, the **last matching rule wins** — put broad catch-alls first and specific overrides after them.\n\nPattern keys support home directory expansion:\n- `~/path` or `$HOME/path` — expanded to the OS home directory at match time.\n- `~` or `$HOME` alone — expands to the home directory itself.\n\nThe stored pattern is always shown in logs and approval dialogs as written (e.g. `~/dev/*`).",
  });

const hardDenyRuleSchema = z
  .strictObject({
    surface: z.enum(["path", "bash"]).meta({
      description:
        "The deterministic routing surface: path matches path-aware access across tools; bash matches the complete shell command.",
    }),
    pattern: z.string().min(1).meta({
      description: "Wildcard pattern matched on the selected surface.",
    }),
    code: z
      .string()
      .regex(/^HARD_DENY_[A-Z0-9_]+$/)
      .meta({
        description:
          "Stable machine-readable denial code beginning with HARD_DENY_.",
      }),
    reason: z.string().min(1).max(500).meta({
      description: "Human-readable explanation shown when the rule blocks.",
    }),
  })
  .meta({
    id: "hardDenyRule",
    description: "One operator-defined deterministic hard-deny rule.",
  });

const hardDenySchema = z
  .array(z.union([z.literal("$defaults"), hardDenyRuleSchema]))
  .superRefine((entries, ctx) => {
    if (entries.filter((entry) => entry === "$defaults").length > 1) {
      ctx.addIssue({
        code: "custom",
        message: '"$defaults" may appear at most once.',
      });
    }
  })
  .meta({
    description:
      "Ordered hard-deny composition. Include $defaults to retain the preceding baseline and append rules; omit it for explicit replacement at operator scope.",
    markdownDescription:
      'Ordered deterministic hard-deny rules. Include `"$defaults"` to retain the built-in/global baseline and append rules. Omitting it explicitly replaces the preceding baseline at operator-controlled global scope. Project rules are tighten-only and cannot remove the global result.',
  });

const permissionSchema = z
  .record(
    z.string().min(1).meta({
      description: "A surface name or the universal fallback key '*'.",
    }),
    z.union([permissionStateSchema, permissionMapSchema]),
  )
  .meta({
    description:
      "Flat permission policy. Each key is a surface name; values are a PermissionState string (catch-all) or a pattern→action map.",
    markdownDescription:
      'Flat permission policy.\n\nEach top-level key is a surface name:\n- `"*"` — universal fallback (replaces `defaultPolicy.tools` from the legacy format)\n- Tool names (`read`, `write`, `bash`, `mcp`, `skill`, `external_directory`, `path`, etc.)\n\nA **string** value is shorthand for `{ "*": action }` (surface-level catch-all).\nAn **object** value maps wildcard patterns to actions — last matching pattern wins.\n\nFor built-in file tools (`read`, `write`, `edit`, `find`, `grep`, `ls`), patterns are matched against the file path from `input.path`. For example, `"read": { "*": "allow", "*.env": "deny" }` allows reads but denies `.env` files.\n\nWhen Pi\'s current working directory is known, relative path inputs also match their cwd-normalized absolute form, so `src/App.jsx` can match both `src/*` and `/workspace/project/*`. Bash path tokens use the effective directory after literal `cd` commands for this matching; non-literal `cd "$DIR"` style commands remain conservative.\n\nThe `path` surface is a cross-cutting gate that applies to **all** file access: Pi tools, bash commands, MCP calls (via `input.arguments.path`), and extension tools (via `input.path` or a registered access extractor). A `path` deny cannot be overridden by a per-tool allow. Use it to protect sensitive files (`.env`, `~/.ssh/*`) from all path-aware tools at once.\n\nThe `external_directory` surface gates access **outside** the working directory. Give it a pattern map to allow specific outside-CWD directories without opening all external access — e.g. `"external_directory": { "*": "ask", "~/.cargo/registry/*": "allow" }` to silence repeated prompts on a local cache. The trailing `*` is greedy and crosses subdirectory boundaries; a bare `~/.cargo/registry` matches only the directory entry itself. Because layers compose with most-restrictive-wins, a `path` allow cannot loosen an `external_directory: ask` boundary — allow outside-CWD directories here, not on `path`.\n\n**Merge order (lowest → highest precedence):** global → project → per-agent frontmatter.',
    examples: [
      {
        "*": "ask",
        path: {
          "*": "allow",
          "*.env": "deny",
          "*.env.*": "deny",
          "*.env.example": "allow",
        },
        read: "allow",
        write: "deny",
        edit: "deny",
        bash: {
          "*": "ask",
          "git *": "ask",
          "git status": "allow",
          "git diff": "allow",
        },
        mcp: { "*": "ask", mcp_status: "allow", "exa:*": "allow" },
        skill: { "*": "ask", librarian: "allow" },
        external_directory: { "*": "ask", "~/.cargo/registry/*": "allow" },
      },
    ],
  });

const shellToolAliasSchema = z
  .strictObject({
    commandArgument: z.string().min(1).meta({
      description:
        "The name of the tool's input argument holding the shell command string (e.g. 'cmd').",
    }),
    workdirArgument: z.string().min(1).optional().meta({
      description:
        "Optional name of the tool's input argument holding the working directory (e.g. 'workdir').",
    }),
  })
  .meta({
    description:
      "Maps one shell-aliased tool to the input arguments holding its command and (optionally) its working directory.",
  });

const shellToolsSchema = z
  .record(
    z.string().min(1).meta({
      description: "A non-bash tool name that carries shell semantics.",
    }),
    shellToolAliasSchema,
  )
  .meta({
    description:
      "Maps non-bash tool names that carry shell semantics to the input arguments holding their command and working directory.",
    markdownDescription:
      'Records which non-`bash` tools carry shell semantics, mapping each tool name to the input argument holding its command (and optionally its working directory).\n\nUse this when an extension replaces the native `bash` tool under a different name — e.g. `@howaboua/pi-codex-conversion` registers `exec_command` with a `cmd` argument and an optional `workdir`. Recording the alias lets the permission system gate that tool through the same bash enforcement stack as native `bash` (command decomposition, wrapper flooring, path/external-directory token gates, and `bash:` rules).\n\nExample:\n\n```json\n"shellTools": {\n  "exec_command": { "commandArgument": "cmd", "workdirArgument": "workdir" }\n}\n```\n\n**Merge order:** shallow-merge by tool name across global → project. Project scope may add aliases, but an operator-defined global mapping wins on key collision so project config cannot blind global bash hard-deny.',
    examples: [
      {
        exec_command: { commandArgument: "cmd", workdirArgument: "workdir" },
      },
    ],
  });

/**
 * The on-disk config file shape.
 *
 * Every field is optional so partial global/project configs merge before the
 * runtime defaults are applied downstream (`normalizePermissionSystemConfig`).
 * No `.default()` lives here — injecting defaults at parse time would break the
 * global-vs-project override semantics. `strictObject` makes unknown top-level
 * keys an error, so editors flag typos and the runtime loader rejects them.
 */
export const unifiedConfigSchema = z
  .strictObject({
    $schema: z.string().optional().meta({
      description: "JSON Schema URI for editor autocomplete and validation.",
    }),
    debugLog: z.boolean().optional().meta({
      description:
        "Write verbose permission-system diagnostics to the extension logs directory.",
      markdownDescription:
        "Write verbose permission-system diagnostics to `logs/pi-permission-system-debug.jsonl` under the extension config directory.",
      default: false,
    }),
    permissionReviewLog: z.boolean().optional().meta({
      description:
        "Write permission request and decision audit events to the extension logs directory.",
      markdownDescription:
        "Write permission request and decision audit events to `logs/pi-permission-system-permission-review.jsonl` under the extension config directory.",
      default: true,
    }),
    yoloMode: z.boolean().optional().meta({
      description:
        "Auto-approve ask-state permission checks, including subagent approval forwarding.",
      markdownDescription:
        "Auto-approve `ask`-state permission checks, including subagent approval forwarding.\n\n⚠️ **Use with caution** — this disables all interactive confirmation prompts.",
      default: false,
    }),
    doublePressToConfirm: z.boolean().optional().meta({
      description:
        "Require a confirming second press of a decision hotkey in the inline permission dialog. Applies to TUI sessions only.",
      markdownDescription:
        "Require a confirming second press of a decision hotkey (`y`/`s`/`n`/`r`) in the inline permission dialog before it commits — the first press arms the action and shows a `Press y again to approve.` hint.\n\nApplies to interactive **TUI** sessions only; the non-TUI (RPC/frontend) prompt keeps its single-select flow. Set to `false` to commit decisions on the first hotkey press.",
      default: true,
    }),
    toolInputPreviewMaxLength: z.number().int().min(1).optional().meta({
      description:
        "Maximum character length of the inline-JSON tool-input preview shown in permission prompts. Omit to use the default (200). Set to a large value to disable truncation.",
      markdownDescription:
        "Maximum character length of the inline-JSON tool-input preview shown in permission prompts.\n\nOmit to use the default (200). Set to a large value (e.g. `10000`) to effectively disable truncation and see the full input.",
    }),
    toolTextSummaryMaxLength: z.number().int().min(1).optional().meta({
      description:
        "Maximum character length of inline pattern/path summaries (e.g. grep patterns, find globs, ls paths) in permission prompts. Omit to use the default (80).",
      markdownDescription:
        "Maximum character length of inline pattern/path summaries (e.g. grep patterns, find globs, ls paths) shown in permission prompts.\n\nOmit to use the default (80). Increase this when working with long regexes or deep paths that are being cut off.",
    }),
    piInfrastructureReadPaths: z.array(z.string().min(1)).optional().meta({
      description:
        "Additional directories to auto-allow for reads as Pi infrastructure, bypassing the external_directory gate. Supports ~ expansion and wildcard patterns (* and ?).",
      markdownDescription:
        "Additional directories to auto-allow for reads as Pi infrastructure, bypassing the `external_directory` gate.\n\nThe extension auto-discovers the global node_modules root (walks up from the extension's install path; falls back to `npm root -g` from a dev checkout), Pi's own install directory (via the coding-agent `getPackageDir()` API), `agentDir`, `agentDir/git`, and project-local `.pi/npm/` and `.pi/git/`. Add entries here for edge cases where auto-discovery is insufficient (e.g. custom `npmCommand` pointing to pnpm).\n\nSupports `~`/`$HOME` expansion. Entries may be plain directory prefixes or wildcard patterns using `*` (matches any characters, including `/`) and `?` (matches exactly one character). `**` and `*` are equivalent — both cross directory boundaries.\n\nOn Windows, matching is case-insensitive and tolerant of either path separator.",
      default: [],
    }),
    authorizerChain: z.array(z.string().min(1)).optional().meta({
      description:
        "Ordered names of registered live-authority chain links to consult before the terminal authorizer. Config order (not registration order) fixes the chain order; an unregistered name is skipped fail-safe (more prompting, never less); a link decides nothing until it is named here.",
      markdownDescription:
        "Ordered names of registered **live-authority chain links** (e.g. a model judge) to consult before the terminal authorizer (the human, or the subagent-forwarding / headless-deny fallback).\n\nA link reviews an `ask` and returns `allow` / `deny` (with an optional teaching reason) / `defer` to the next link. Three invariants govern the chain:\n\n- **Config order wins.** The order here — not the order extensions register in — fixes the security-relevant chain order.\n- **Fail-safe skip.** A name with no registered link is skipped with a warning; the `ask` still reaches the terminal (more prompting, never less).\n- **Opt-in activation.** Installing a judge extension grants it no authority; a link decides nothing until you name it here.\n\nThis local fork permits reviewed `external_directory` asks. Each link registration defaults to the bounded `cap-allow` path mode: its `allow` on `path` is downgraded to `defer` so the terminal decides. A link may explicitly register with `honor-reviewer` to preserve path allows; undetermined surfaces remain capped fail-safe, and deterministic policy denies resolve before the chain.\n\nDefaults to an empty list (no links).",
      default: [],
    }),
    hardDeny: hardDenySchema.optional(),
    permission: permissionSchema.optional(),
    shellTools: shellToolsSchema.optional(),
  })
  .meta({
    title: "PI Permission System Configuration",
    description:
      "Unified config file combining runtime knobs and flat permission policy for pi-permission-system.",
    markdownDescription:
      "Unified config file combining runtime knobs and flat permission policy for [pi-permission-system](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system).\n\nPlace at `~/.pi/agent/extensions/pi-permission-system/config.json` (global) or `<project>/.pi/extensions/pi-permission-system/config.json` (project).",
  });

/** A permission decision. */
export type PermissionState = z.infer<typeof permissionStateSchema>;

/** A deny action with an optional custom reason. */
export type DenyWithReason = z.infer<typeof denyWithReasonSchema>;

/** A pattern value: a PermissionState string OR a DenyWithReason object. */
export type PatternValue = z.infer<typeof patternValueSchema>;

/** The on-disk permission shape inside the `"permission"` key. */
export type FlatPermissionConfig = z.infer<typeof permissionSchema>;

/** The `shellTools` map: tool name → shell-alias argument mapping. */
export type ShellToolsConfig = z.infer<typeof shellToolsSchema>;

/** One operator-defined deterministic hard-deny rule. */
export type HardDenyRule = z.infer<typeof hardDenyRuleSchema>;

/** Raw hard-deny composition list, optionally retaining the preceding defaults. */
export type HardDenyConfig = z.infer<typeof hardDenySchema>;

/** The raw config file shape after validation (all fields optional). */
export type UnifiedPermissionConfig = z.infer<typeof unifiedConfigSchema>;

/**
 * Derive the published JSON Schema (Draft 2020-12) from the zod source.
 *
 * The three id-tagged sub-schemas (`permissionState`, `permissionMap`,
 * `denyWithReason`) become `$defs` referenced by `$ref`; everything else
 * inlines. The root `$id` is set to the canonical monorepo URL.
 */
export function buildPermissionsJsonSchema(): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(unifiedConfigSchema, {
    target: "draft-2020-12",
  });
  return { $schema, $id: PERMISSIONS_SCHEMA_URL, ...rest };
}
