// The authorization CONTRACT. It lives in the kernel; the implementation lives in the `auth`
// cube.
//
// If `notes` imported `Authorization` from `../auth/index.ts`, every cube would import another
// cube. It looks harmless — it is only middleware — but it breaks the invariant: a cube could
// no longer be read, moved or deleted without touching another. It is also exactly the import
// `dependency-cruiser` refuses.
//
// So: the kernel DECLARES the tag, the `auth` cube IMPLEMENTS it. Cubes depend on the
// contract, never the implementation. The "dead without auth" rule does not weaken: with no
// auth cube there is nobody to satisfy the tag, so the server refuses to start (`mount.ts`).

import { HttpApiMiddleware, HttpApiSecurity } from "@effect/platform"
import { Context, Effect } from "effect"
import { Forbidden, Unauthorized } from "./errors.ts"

export class CurrentUser extends Context.Tag("cubes/CurrentUser")<
  CurrentUser,
  {
    readonly id: string
    readonly username: string
    readonly roles: ReadonlyArray<string>
    readonly permissions: ReadonlyArray<string>
    /**
     * Which session made this request. The middleware carries it next to the user (QWB-54,
     * ticket 21) so `auth:logout` can drop exactly that session instead of every session of
     * the account -- logging out on the phone must not log the laptop out.
     */
    readonly sessionId: string
  }
>() {}

/** Useful side effect: the Bearer scheme shows up in the emitted OpenAPI. */
export class Authorization extends HttpApiMiddleware.Tag<Authorization>()("cubes/Authorization", {
  security: { bearer: HttpApiSecurity.bearer },
  provides: CurrentUser,
  failure: Unauthorized,
}) {}

/**
 * Permission check.
 *
 * Without it a valid token would grant everything: the token says who you are, the role says
 * what you may do. Permissions come from the cubes' manifests, aggregated by the kernel — so a
 * new cube brings its own without editing `auth`.
 */
export const requirePermission = (permission: string) =>
  Effect.gen(function* () {
    const user = yield* CurrentUser
    if (!user.permissions.includes(permission)) {
      return yield* Effect.fail(new Forbidden({ message: "your role is not allowed", needed: permission }))
    }
    return user
  })
