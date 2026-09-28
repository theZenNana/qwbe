import { Effect, Option, Ref } from "effect"
import type { CredentialVerifier } from "./kernel/manifest.ts"
import type { IdentityDirectory, PermissionService } from "./permissions-contracts.ts"
import { PermissionInvalid } from "./permissions-contracts.ts"

/**
 * A service whose provider is bound after the consumer received it: every method reads the
 * provider bound NOW and calls it, or answers what `fallback` answers when none is bound yet.
 * `fallback` is typed as the full service, so it names every method -- that list is the one the
 * wrapper is built from.
 */
export const lateBound = <S extends object>(bound: Ref.Ref<Option.Option<S>>, fallback: S): S =>
  Object.fromEntries(
    Object.keys(fallback).map((method) => [
      method,
      (...args: ReadonlyArray<unknown>) =>
        Effect.flatMap(Ref.get(bound), (current) => {
          const target = Option.getOrElse(current, () => fallback) as Record<
            string,
            (...a: ReadonlyArray<unknown>) => unknown
          >
          return target[method]!(...args) as Effect.Effect<unknown, unknown>
        }),
    ]),
  ) as S

const unavailable = () => Effect.fail(new PermissionInvalid({ message: "entity permissions provider unavailable" }))

/** No credentials provider: nobody verifies. */
export const noCredentials: CredentialVerifier = { verify: () => Effect.succeed(undefined) }

/** No identity directory: no username resolves. */
export const noIdentityDirectory: IdentityDirectory = { resolveUsername: () => Effect.succeed(undefined) }

/** No entity permissions provider: reads answer "nothing", writes answer "unavailable". */
export const noPermissionService: PermissionService = {
  claim: unavailable,
  ownership: () => Effect.succeed(undefined),
  authorize: () => Effect.succeed({ allowed: false, source: "none" }),
  authorizeList: () => Effect.succeed(new Set<string>()),
  auditList: () => Effect.void,
  assignCubeAdmin: unavailable,
  revokeCubeAdmin: unavailable,
  cubeAdmins: unavailable,
  transferOwnership: unavailable,
  audit: () => Effect.succeed([]),
  createGroup: unavailable,
  renameGroup: unavailable,
  groups: unavailable,
  addGroupMember: unavailable,
  removeGroupMember: unavailable,
  groupMembers: unavailable,
  grantUser: unavailable,
  grantGroup: unavailable,
  revokeGrant: unavailable,
  listGrants: unavailable,
  grantCapability: unavailable,
  revokeCapabilityGrant: unavailable,
  listCapabilityGrants: unavailable,
  // No provider, no grants: the auth middleware unions this with the role permissions.
  capabilitiesFor: () => Effect.succeed([]),
  listVisible: (_actor, _cube, _view, page) =>
    Effect.succeed({ rows: [], total: 0, offset: page.offset, limit: page.limit, sortedBy: "createdAt" }),
  setHidden: unavailable,
}
