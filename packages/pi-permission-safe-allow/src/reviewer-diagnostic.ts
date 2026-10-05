export type ReviewFailureCode = "auth" | "audit" | "cancelled" | "authorization_changed" | "evidence" | "model" | "parse" | "timeout" | "transport";

export interface BackendDiagnostic {
  source: "chat" | "evaluation" | "authentication" | "review";
  classification: ReviewFailureCode;
  stopReason?: "error" | "aborted";
  httpStatus?: number;
}

export interface ReviewerDiagnostic extends BackendDiagnostic {
  attempt: number;
  provider: string;
  model: string;
  backend: "chat" | "evaluation";
  durationMs: number;
}

export function structuredHttpStatus(error: unknown): number | undefined {
  try {
    if (!error || typeof error !== "object") return undefined;
    for (const key of ["statusCode", "status", "httpStatus"] as const) {
      const value: unknown = Reflect.get(error, key);
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    }
  } catch {
    // Provider objects may expose throwing getters; no diagnostic is safer than inspecting further.
  }
  return undefined;
}
