/**
 * Credential-name checks shared by local-fact reads and fact-request parsing.
 * Filename checks share one token list. The content scan stays a separate
 * expression: it matches `authorization` and `api-key` spellings and does not
 * treat a bare `auth` substring as a secret. Unifying them would change denials.
 */
export const CREDENTIAL_NAME_TOKENS =
  "secret|credential|password|passwd|token|cookie|oauth|auth|private[-_]?key|keychain|id_rsa|id_ed25519";

/** Whole path segment: dotfiles, credential names, and key-file extensions. */
export const SENSITIVE_PATH_SEGMENT = new RegExp(
  `^(?:\\..*|.*(?:${CREDENTIAL_NAME_TOKENS}|id_ecdsa|id_dsa|\\.(?:pem|key|p12|pfx)).*)$`,
  "i",
);

/** Basename fragment used before a fact read is attempted. */
export const SECRET_BASENAME = new RegExp(
  `(?:${CREDENTIAL_NAME_TOKENS}|\\.pem|\\.key|\\.p12|\\.pfx)`,
  "i",
);

/** File-body scan. Not interchangeable with {@link SENSITIVE_PATH_SEGMENT}. */
export const SECRET_CONTENT =
  /(?:secret|credential|password|passwd|token|cookie|oauth|authorization|private[-_]?key|api[-_]?key)/i;
