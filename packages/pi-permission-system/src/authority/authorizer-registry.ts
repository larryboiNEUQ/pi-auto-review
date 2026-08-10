/**
 * Registry for named live-authority chain links (ADR 0007 §4).
 *
 * A downstream extension offers a named `Authorizer` link via
 * `PermissionsService.registerAuthorizer`; this registry stores the link's
 * `authorize` callback and path-envelope mode so composition can bind names to
 * capabilities. One link per name; duplicate registration throws.
 *
 * Registration alone grants no authority — a link decides nothing until the
 * operator names it in the `authorizerChain` config (the opt-in activation
 * model). `AuthorizerSelection` owns that config-order resolution; this registry
 * is storage only.
 */

import type {
  Authorizer,
  AuthorizerRegistrationOptions,
  PathEnvelopeMode,
} from "./authorizer";

/**
 * Read-only lookup used by chain composition (ISP — exposes only the read side,
 * not the registration surface).
 */
export interface AuthorizerLookup {
  get(name: string): Authorizer["authorize"] | undefined;
  getPathEnvelopeMode(name: string): PathEnvelopeMode;
}

/**
 * Registration side of the registry (ISP — exposes only the write surface,
 * mirroring the read-only {@link AuthorizerLookup}).
 */
export interface AuthorizerRegistrar {
  register(
    name: string,
    authorize: Authorizer["authorize"],
    options?: AuthorizerRegistrationOptions,
  ): () => void;
}

/**
 * Persistent registry mapping link names to callbacks and path-envelope modes.
 *
 * Owned by the extension factory (`index.ts`) so it survives across session
 * activations. Exposed to sibling extensions via
 * `PermissionsService.registerAuthorizer` and consulted by
 * `AuthorizerSelection` during chain resolution.
 */
interface RegisteredAuthorizer {
  authorize: Authorizer["authorize"];
  pathEnvelopeMode: PathEnvelopeMode;
}

export class AuthorizerRegistry
  implements AuthorizerLookup, AuthorizerRegistrar
{
  private readonly registrations = new Map<string, RegisteredAuthorizer>();

  /**
   * Register a link and its path-envelope mode under `name`.
   *
   * The mode defaults to the safer `cap-allow`; only an explicit
   * `honor-reviewer` registration opts out. Throws if a link is already registered
   * for that name. The identity-guarded disposer removes both callback and mode
   * without allowing a stale call to evict a later registration.
   */
  register(
    name: string,
    authorize: Authorizer["authorize"],
    options?: AuthorizerRegistrationOptions,
  ): () => void {
    if (this.registrations.has(name)) {
      throw new Error(`An authorizer is already registered for '${name}'.`);
    }
    const registration: RegisteredAuthorizer = {
      authorize,
      pathEnvelopeMode: options?.pathEnvelopeMode ?? "cap-allow",
    };
    this.registrations.set(name, registration);
    return () => {
      if (this.registrations.get(name) === registration) {
        this.registrations.delete(name);
      }
    };
  }

  get(name: string): Authorizer["authorize"] | undefined {
    return this.registrations.get(name)?.authorize;
  }

  getPathEnvelopeMode(name: string): PathEnvelopeMode {
    return this.registrations.get(name)?.pathEnvelopeMode ?? "cap-allow";
  }
}
