import { Effect } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import { BadRequest, Conflict, Forbidden, NotFound } from "qwbe-core/errors"
import {
  type IdentityDirectory,
  type PermissionActor,
  PermissionConflict,
  PermissionForbidden,
  PermissionInvalid,
  PermissionNotFound,
  type PermissionServiceError,
} from "qwbe-core/permissions"

export const actorFrom = (user: typeof CurrentUser.Service): PermissionActor => ({ userId: user.id, roles: user.roles })
export const permissionHttpError = (needed: string) => (error: PermissionServiceError) => {
  if (error instanceof PermissionNotFound) return new NotFound({ message: error.message })
  if (error instanceof PermissionInvalid) return new BadRequest({ message: error.message })
  if (error instanceof PermissionConflict) return new Conflict({ message: error.message })
  if (error instanceof PermissionForbidden) return new Forbidden({ message: error.message, needed })
  return error satisfies never
}
export const mapPermissionError =
  (needed: string) =>
  <A, R>(effect: Effect.Effect<A, PermissionServiceError, R>) =>
    Effect.mapError(effect, permissionHttpError(needed))
export const resolveIdentity = (identities: IdentityDirectory | undefined, username: string) =>
  Effect.gen(function* () {
    const identity = identities ? yield* identities.resolveUsername(username) : undefined
    if (!identity) {
      return yield* Effect.fail(new NotFound({ message: `username ${username} does not exist` }))
    }
    return identity
  })
