import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type PersistentReviewerScope = "Project" | "Global";

export interface ReviewerModelReference {
  provider: string;
  model: string;
}

export class ReviewerModelPersistenceError extends Error {
  constructor(
    readonly scope: PersistentReviewerScope,
    readonly path: string,
    message: string,
  ) {
    super(`${scope} reviewer configuration at ${path}: ${message}`);
  }
}

export interface PersistentMutation {
  rollback(): void;
}

function parseObject(
  scope: PersistentReviewerScope,
  path: string,
  bytes: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new ReviewerModelPersistenceError(scope, path, `malformed JSON (${problem})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReviewerModelPersistenceError(scope, path, "expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function atomicWrite(
  scope: PersistentReviewerScope,
  path: string,
  bytes: string,
  mode?: number,
): void {
  const directory = dirname(path);
  let temporaryPath: string | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    temporaryPath = join(directory, `.config.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, bytes, {
      encoding: "utf8",
      flag: "wx",
      mode: mode ?? 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    if (temporaryPath) rmSync(temporaryPath, { force: true });
    const problem = error instanceof Error ? error.message : String(error);
    throw new ReviewerModelPersistenceError(scope, path, `write failed (${problem})`);
  }
}

export function mutatePersistentReviewerModel(options: {
  scope: PersistentReviewerScope;
  path: string;
  selection?: ReviewerModelReference;
}): PersistentMutation {
  const { scope, path, selection } = options;
  const existed = existsSync(path);
  let originalBytes: string | undefined;
  let mode: number | undefined;
  let object: Record<string, unknown> = {};

  if (existed) {
    try {
      originalBytes = readFileSync(path, "utf8");
      mode = statSync(path).mode;
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      throw new ReviewerModelPersistenceError(scope, path, `read failed (${problem})`);
    }
    object = parseObject(scope, path, originalBytes);
  }

  if (selection) {
    object.provider = selection.provider;
    object.model = selection.model;
  } else {
    delete object.provider;
    delete object.model;
  }

  const updatedBytes = `${JSON.stringify(object, null, 2)}\n`;
  atomicWrite(scope, path, updatedBytes, mode);

  return {
    rollback() {
      if (!existed) {
        try {
          rmSync(path, { force: true });
        } catch (error) {
          const problem = error instanceof Error ? error.message : String(error);
          throw new ReviewerModelPersistenceError(scope, path, `rollback failed (${problem})`);
        }
        return;
      }
      atomicWrite(scope, path, originalBytes!, mode);
    },
  };
}
