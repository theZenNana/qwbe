import { Effect } from "effect"
import type { CurrentUser } from "qwbe-core/auth"
import { Forbidden } from "qwbe-core/errors"
import type { IdentityDirectory, PermissionActor } from "qwbe-core/permissions"

export const actorFrom = (user: typeof CurrentUser.Service): PermissionActor => ({ userId: user.id, roles: user.roles })
export const forbidden = (needed: string) => (message: string) => new Forbidden({ message, needed })
export const resolveIdentity = (identities: IdentityDirectory | undefined, username: string, needed: string) =>
  Effect.gen(function* () {
    const identity = identities ? yield* identities.resolveUsername(username) : undefined
    if (!identity) {
      return yield* Effect.fail(new Forbidden({ message: `username ${username} does not exist`, needed }))
    }
    return identity
  })
