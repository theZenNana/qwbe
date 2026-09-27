import { Effect, Match } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import { BadRequest, Conflict, Forbidden, NotFound } from "qwbe-core/errors"
import type { PageResponse } from "qwbe-core/http"
import type { IdentityDirectory, PermissionActor, PermissionServiceError } from "qwbe-core/permissions"

export const actorFrom = (user: typeof CurrentUser.Service): PermissionActor => ({ userId: user.id, roles: user.roles })
export const permissionHttpError = (needed: string) =>
  Match.typeTags<PermissionServiceError>()({
    PermissionNotFound: (error) => new NotFound({ message: error.message }),
    PermissionInvalid: (error) => new BadRequest({ message: error.message }),
    PermissionConflict: (error) => new Conflict({ message: error.message }),
    PermissionForbidden: (error) => new Forbidden({ message: error.message, needed }),
  })
export const mapPermissionError =
  (needed: string) =>
  <A, R>(effect: Effect.Effect<A, PermissionServiceError, R>) =>
    Effect.mapError(effect, permissionHttpError(needed))
export const page = <A>(rows: ReadonlyArray<A>, offset: number, limit: number, sortedBy: string): PageResponse<A> => ({
  rows: rows.slice(offset, offset + limit),
  total: rows.length,
  offset,
  limit,
  sortedBy,
})
export const resolveIdentity = (identities: IdentityDirectory | undefined, username: string) =>
  Effect.gen(function* () {
    const identity = identities ? yield* identities.resolveUsername(username) : undefined
    if (!identity) {
      return yield* Effect.fail(new NotFound({ message: `username ${username} does not exist` }))
    }
    return identity
  })
