import { redactApprovalSecrets } from "@gotgenes/pi-permission-system";

/** Reviewer-facing alias for the permission system's single redaction contract. */
export const redactSecrets = redactApprovalSecrets;

export function secretSafeJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value));
}
