import { homedir } from "node:os";

import type { AccessPath } from "#src/access-intent/access-path";
import type { BashProgram } from "#src/access-intent/bash/program";
import { getToolInputPath } from "#src/access-intent/tool-input-path";
import type { PathNormalizer } from "#src/path-normalizer";
import type { ToolAccessExtractorLookup } from "#src/tool-access-extractor-registry";
import type { GateBlock, HardDenyCode } from "./descriptor";
import type { ToolCallContext } from "./types";

const MUTATING_PATH_TOOLS = new Set(["write", "edit"]);
const MUTATING_BASH_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "tee",
  "touch",
  "truncate",
]);
const EXEC_WRAPPERS = new Set(["command", "doas", "env", "sudo"]);
const WRAPPER_VALUE_OPTIONS = new Set([
  "--chdir",
  "--chroot",
  "--close-from",
  "--group",
  "--host",
  "--prompt",
  "--split-string",
  "--unset",
  "--user",
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-R",
  "-S",
  "-u",
]);
const SHELL_PROFILE_NAMES = [
  ".bash_profile",
  ".bash_login",
  ".bashrc",
  ".profile",
  ".zprofile",
  ".zshenv",
  ".zshrc",
];


const HARD_DENY_REASONS: Record<HardDenyCode, string> = {
  HARD_DENY_CATASTROPHIC_DELETE:
    "catastrophic filesystem delete is blocked by the built-in safety baseline",
  HARD_DENY_PERMISSION_CONTROL:
    "modifying permission-control configuration is blocked by the built-in safety baseline",
  HARD_DENY_PERSISTENCE_AGENT:
    "modifying persistence-agent definitions is blocked by the built-in safety baseline",
  HARD_DENY_SECRET_PATH:
    "access to a high-sensitivity secret path is blocked by the built-in safety baseline",
  HARD_DENY_SHELL_PROFILE:
    "access to shell startup profiles is blocked by the built-in safety baseline",
  HARD_DENY_SSH_AUTHORIZED_KEYS:
    "modifying SSH authorized_keys is blocked by the built-in safety baseline",
};

interface PathFinding {
  code: HardDenyCode;
  path: AccessPath;
}

export function describeBuiltInHardDeny(
  tcc: ToolCallContext,
  normalizer: PathNormalizer,
  bashProgram: BashProgram | null,
  customExtractors?: ToolAccessExtractorLookup,
): GateBlock | null {
  if (bashProgram) {
    if (bashProgram.commands().some(({ text }) => isCatastrophicRm(text, normalizer))) {
      return makeBlock(
        tcc,
        "HARD_DENY_CATASTROPHIC_DELETE",
        "bash",
        bashProgram.commandText(),
        { command: bashProgram.commandText() },
      );
    }

    const bashFinding = firstPathFinding(
      bashProgram.pathRuleCandidates().map(({ path }) => path),
      normalizer,
      hasMutatingBashOperation(bashProgram),
    );
    if (bashFinding) {
      return makeBlock(tcc, bashFinding.code, "bash", bashFinding.path.value(), {
        command: bashProgram.commandText(),
        path: bashFinding.path.value(),
      });
    }
  }

  const rawPath = getToolInputPath(tcc.toolName, tcc.input, customExtractors);
  if (rawPath === null) return null;

  const path = normalizer.forPath(rawPath);
  const finding = classifyPath(
    path,
    normalizer,
    MUTATING_PATH_TOOLS.has(tcc.toolName),
  );
  return finding
    ? makeBlock(tcc, finding.code, tcc.toolName, path.value(), {
        path: path.value(),
      })
    : null;
}

function makeBlock(
  tcc: ToolCallContext,
  code: HardDenyCode,
  surface: string,
  value: string,
  details: Record<string, unknown>,
): GateBlock {
  return {
    action: "block",
    code,
    reason: `${code}: ${HARD_DENY_REASONS[code]}`,
    surface,
    value,
    logContext: {
      source: "tool_call",
      toolCallId: tcc.toolCallId,
      toolName: tcc.toolName,
      ...details,
    },
  };
}

function firstPathFinding(
  paths: readonly AccessPath[],
  normalizer: PathNormalizer,
  mutationCapable: boolean,
): PathFinding | null {
  for (const path of paths) {
    const finding = classifyPath(path, normalizer, mutationCapable);
    if (finding) return finding;
  }
  return null;
}

function classifyPath(
  path: AccessPath,
  normalizer: PathNormalizer,
  mutationCapable: boolean,
): PathFinding | null {
  if (safetyValues(path).some((value) => isSecretValue(value, normalizer))) {
    return { code: "HARD_DENY_SECRET_PATH", path };
  }
  if (SHELL_PROFILE_NAMES.some((name) => matchesHomePath(path, normalizer, name))) {
    return { code: "HARD_DENY_SHELL_PROFILE", path };
  }
  if (!mutationCapable) return null;
  if (matchesSuffix(path, normalizer, ".ssh", "authorized_keys")) {
    return { code: "HARD_DENY_SSH_AUTHORIZED_KEYS", path };
  }
  if (isPersistencePath(path, normalizer)) {
    return { code: "HARD_DENY_PERSISTENCE_AGENT", path };
  }
  if (isPermissionControlPath(path, normalizer)) {
    return { code: "HARD_DENY_PERMISSION_CONTROL", path };
  }
  return null;
}

function matchesHomePath(
  path: AccessPath,
  normalizer: PathNormalizer,
  ...parts: string[]
): boolean {
  const protectedValues = new Set(
    safetyValues(
      normalizer.forPath(normalizer.flavor.impl.join(homedir(), ...parts)),
    ),
  );
  return safetyValues(path).some((value) => protectedValues.has(value));
}

function matchesSuffix(
  path: AccessPath,
  normalizer: PathNormalizer,
  ...parts: string[]
): boolean {
  return safetyValues(path).some((value) =>
    matchesValueSuffix(value, normalizer, ...parts),
  );
}

function isWithinSuffix(
  path: AccessPath,
  normalizer: PathNormalizer,
  ...parts: string[]
): boolean {
  const { impl } = normalizer.flavor;
  const suffix = normalizer.flavor.fold(impl.join(...parts));
  const nestedMarker = `${impl.sep}${suffix}${impl.sep}`;
  return safetyValues(path).some((value) => {
    const folded = normalizer.flavor.fold(value);
    return (
      folded.includes(nestedMarker) ||
      folded.endsWith(`${impl.sep}${suffix}`) ||
      folded.startsWith(`${suffix}${impl.sep}`)
    );
  });
}

function isPersistencePath(path: AccessPath, normalizer: PathNormalizer): boolean {
  return (
    isWithinSuffix(path, normalizer, "Library", "LaunchAgents") ||
    isWithinSuffix(path, normalizer, "Library", "LaunchDaemons") ||
    isWithinSuffix(path, normalizer, ".config", "systemd", "user") ||
    isWithinSuffix(path, normalizer, "etc", "systemd", "system") ||
    isWithinSuffix(path, normalizer, "etc", "cron.d") ||
    isWithinSuffix(
      path,
      normalizer,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
    )
  );
}

function isPermissionControlPath(
  path: AccessPath,
  normalizer: PathNormalizer,
): boolean {
  return (
    matchesSuffix(
      path,
      normalizer,
      "extensions",
      "pi-permission-system",
      "config.json",
    ) ||
    matchesSuffix(
      path,
      normalizer,
      "extensions",
      "pi-permission-safe-allow",
      "config.json",
    ) ||
    isWithinSuffix(path, normalizer, ".pi", "agents") ||
    matchesSuffix(path, normalizer, "pi-permissions.jsonc")
  );
}

function safetyValues(path: AccessPath): string[] {
  return [path.value(), path.resolvedAlias()].filter(
    (value): value is string => Boolean(value),
  );
}

function isSecretValue(value: string, normalizer: PathNormalizer): boolean {
  const { impl } = normalizer.flavor;
  const name = impl.basename(value);
  const envFile =
    /^\.env(?:\..+)?$/.test(name) &&
    !/^\.env\.(?:example|sample|template)$/.test(name);
  const privateSshKey =
    impl.basename(impl.dirname(value)) === ".ssh" &&
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(name);
  return (
    envFile ||
    privateSshKey ||
    matchesValueSuffix(value, normalizer, ".aws", "credentials") ||
    matchesValueSuffix(value, normalizer, ".kube", "config") ||
    matchesValueSuffix(
      value,
      normalizer,
      ".config",
      "gcloud",
      "application_default_credentials.json",
    ) ||
    [".git-credentials", ".netrc"].includes(name)
  );
}

function matchesValueSuffix(
  value: string,
  normalizer: PathNormalizer,
  ...parts: string[]
): boolean {
  const suffix = normalizer.flavor.fold(normalizer.flavor.impl.join(...parts));
  return normalizer.flavor.fold(value).endsWith(suffix);
}

function isCatastrophicRm(text: string, normalizer: PathNormalizer): boolean {
  const opaquePayload = extractOpaqueShellPayload(text);
  if (opaquePayload !== null) {
    return opaquePayload
      .split(/\s*(?:&&|\|\||[;&|])\s*/)
      .some((command) => isCatastrophicRm(command, normalizer));
  }
  const tokens = text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
  const rmIndex = findRmExecutableIndex(tokens);
  if (rmIndex === -1) return false;

  let recursive = false;
  let force = false;
  let optionsEnded = false;
  const targets: string[] = [];
  for (const token of tokens.slice(rmIndex + 1)) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && token.startsWith("-")) {
      recursive ||= token === "--recursive" || /^-[^-]*[rR]/.test(token);
      force ||= token === "--force" || /^-[^-]*f/.test(token);
    } else {
      targets.push(token);
    }
  }
  if (!recursive || !force) return false;

  const home = normalizer.forBashToken(homedir()).boundaryValue();
  return targets.some((target) => {
    const unquotedTarget = target.replace(/["']/g, "");
    if (
      ["/", "/*"].includes(unquotedTarget) ||
      /^(?:~|\$HOME|\$\{HOME\})(?:\/(?:\*)?)?$/.test(unquotedTarget)
    ) {
      return true;
    }
    const boundary = normalizer.forBashToken(unquotedTarget).boundaryValue();
    const root = normalizer.flavor.impl.parse(boundary).root;
    return (
      boundary !== "" &&
      (normalizer.flavor.fold(boundary) === normalizer.flavor.fold(root) ||
        normalizer.flavor.fold(boundary) === normalizer.flavor.fold(home))
    );
  });
}

function extractOpaqueShellPayload(text: string): string | null {
  const trimmed = text.trim();
  const shell =
    /(?:^|\s)(?:bash|dash|ksh|sh|zsh)\s+(?:-\S+\s+)*-c\s+(["'])([\s\S]*)\1\s*$/.exec(
      trimmed,
    );
  if (shell?.[2]) return shell[2];
  const evaluated = /(?:^|\s)eval\s+(["'])([\s\S]*)\1\s*$/.exec(trimmed);
  return evaluated?.[2] ?? null;
}

function hasMutatingBashOperation(program: BashProgram): boolean {
  if (/(?:^|\s)(?:\d*>>?|&>>?)\s*\S/.test(program.commandText())) {
    return true;
  }
  return program.commands().some(({ text }) => {
    const tokens = text.trim().split(/\s+/);
    const executableIndex = findWrappedExecutableIndex(tokens);
    const executable = tokens[executableIndex]?.split("/").at(-1);
    return executable !== undefined && MUTATING_BASH_COMMANDS.has(executable);
  });
}

function findRmExecutableIndex(tokens: readonly string[]): number {
  const index = findWrappedExecutableIndex(tokens);
  return tokens[index]?.split("/").at(-1) === "rm" ? index : -1;
}

function findWrappedExecutableIndex(tokens: readonly string[]): number {
  let commandIndex = 0;
  while (commandIndex < tokens.length) {
    const command = tokens[commandIndex]?.split("/").at(-1);
    if (!command || !EXEC_WRAPPERS.has(command)) return commandIndex;
    commandIndex = wrappedCommandIndex(tokens, commandIndex, command);
    if (commandIndex === -1) return -1;
  }
  return -1;
}

function wrappedCommandIndex(
  tokens: readonly string[],
  wrapperIndex: number,
  wrapper: string,
): number {
  for (let index = wrapperIndex + 1; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token === "--") return index + 1 < tokens.length ? index + 1 : -1;
    if (token.startsWith("-")) {
      if (WRAPPER_VALUE_OPTIONS.has(token)) index++;
      continue;
    }
    if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return index;
  }
  return -1;
}
