/** Pi 0.85.1 is the first usable SDK release with an abort check before prepared calls execute. */
export const MIN_BATCH_HOST_VERSION = "0.85.1";

export function supportsBatchCancellation(version: string | undefined): boolean {
  // Unknown and prerelease hosts do not attest a stable cancellation contract.
  const match = version && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  return major! > 0 || minor! > 85 || (minor === 85 && patch! >= 1);
}
