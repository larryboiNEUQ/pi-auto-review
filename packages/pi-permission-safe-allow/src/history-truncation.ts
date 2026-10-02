/** Codex Guardian's approximate four UTF-8 bytes/token head/tail recovery.
 * This sizing unit is deliberately separate from Pi's request admission estimate.
 * The marker can exceed a tiny budget; callers must measure the whole request. */
export function truncateHistoricalText(text: string, maxTokens: number): string {
  const bytes = Buffer.from(text, "utf8");
  const maxBytes = maxTokens * 4;
  if (bytes.length <= maxBytes) return text;
  const omittedTokens = Math.ceil((bytes.length - maxBytes) / 4);
  const marker = `<truncated omitted_approx_tokens="${omittedTokens}" />`;
  if (maxBytes <= marker.length) return marker;
  const available = maxBytes - marker.length;
  let prefixEnd = Math.floor(available / 2);
  let suffixStart = bytes.length - (available - prefixEnd);
  // Continuation bytes cannot begin a code point. Move inward at both cuts.
  while ((bytes[prefixEnd]! & 0xc0) === 0x80) prefixEnd--;
  while ((bytes[suffixStart]! & 0xc0) === 0x80) suffixStart++;
  return bytes.subarray(0, prefixEnd).toString("utf8") + marker + bytes.subarray(suffixStart).toString("utf8");
}
