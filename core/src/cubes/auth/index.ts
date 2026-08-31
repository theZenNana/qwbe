// The AUTH cube. Sessions only — who is logged in, and for how long.
//
// Users, roles and their permissions live in the `account` cube. This one owns exactly one
// table, `sessions`, and it reaches user data the same way anyone else would: through the
// registry. That split is deliberate. In the previous iteration auth held both, which meant
// the cube everything depends on was also the cube holding the most business logic.
//
// Tokens are OPAQUE, not JWT:
//   - the token is 32 random bytes, base64url;
//   - the server stores only `sha256(token)` plus an expiry;
//   - validation is hash-and-look-up; logout deletes the row.
// The usual counter-argument for stateless tokens — saving a database round trip — does not
// apply, because a look-up happens on every request anyway. A database leak yields zero usable
// sessions.
//
// Password login, as asked. Public/private keys would change this cube and nothing else: the
// rest of the system only ever sees `CurrentUser`.

import { createHash, randomBytes } from "node:crypto"
import { HttpApiEndpoint, HttpApiGroup, HttpServerRequest } from "@effect/platform"
import { type Context, Effect, Layer, Option, Redacted } from "effect"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Credentials, Me, Ok, SessionToken } from "../../http-contracts.ts"
import { Authorization, CurrentUser } from "../../kernel/auth-contract.ts"
import { Unauthorized } from "../../kernel/errors.ts"
import { callerOf } from "../../kernel/refusal-log.ts"
import { Registry } from "../../kernel/registry.ts"

const SESSIONS = "sessions"
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

type Session = { id: string; tokenHash: string; accountId: string; expiresAt: string }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")

/**
 * Prototype password hashing. NOT production: a real system uses argon2id, as the system this
 * borrows from does. Written plainly so nobody mistakes this for finished work.
 *
 * Shared with the `account` cube by duplication rather than by import — three lines copied is
 * cheaper than a cube importing another cube, which is the one thing the whole design forbids.
 * When it becomes real, hashing moves behind the account cube's own endpoint.
 */
// --- contract ---

// `login` is the ONLY public endpoint in the whole system. `mount.ts` verifies that against
// the real contract: any other cube with an unauthenticated endpoint stops the server.
const group = HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.post("login")`/auth/login`.setPayload(Credentials).addSuccess(SessionToken).addError(Unauthorized),
  )
  .add(HttpApiEndpoint.get("me")`/auth/me`.addSuccess(Me).addError(Unauthorized).middleware(Authorization))
  .add(HttpApiEndpoint.post("logout")`/auth/logout`.addSuccess(Ok).addError(Unauthorized).middleware(Authorization))

/**
 * The account cube exposes credentials and roles as a `Summary`, which is a deliberately narrow
 * channel: auth reads named details rather than knowing account's columns.
 *
 * `verify` is the sole crossing point, and it goes through the registry — the same route any
 * cube would use.
 */
/**
 * Read a named detail out of a public summary.
 *
 * Only non-secret fields travel this way now. Credential checking moved to the `credentials`
 * capability precisely because a summary is visible to anyone holding `links:read`.
 */
const detail = (summary: { details: ReadonlyArray<{ key: string; value: string }> }, key: string) =>
  summary.details.find((d) => d.key === key)?.value ?? ""

export const cube = defineCube(group, {
  manifest: {
    name: "auth",
    tables: [SESSIONS],
    requiresAuth: false,
    required: true,
    // Declared need. The kernel wires it to whichever cube declares `providesCredentials`.
    usesCredentials: true,
    permissions: [{ name: "auth:session", roles: ["admin", "reader"] }],
    publishes: ["auth.loggedIn", "auth.loggedOut"],
  },

  create: ({ store, bus, permissions, credentials }: CubeTools) => {
    /** Drop expired rows. Cheap, and it keeps validation from scanning dead history. */
    const dropExpiredSessions = Effect.gen(function* () {
      const now = Date.now()
      const rows = yield* store.all<Session>(SESSIONS)
      for (const s of rows) {
        if (new Date(s.expiresAt).getTime() <= now) yield* store.update(SESSIONS, s.id, { deleted: true })
      }
    })

    /** Effective permissions for a set of roles, computed from EVERY cube's manifest. */
    const permissionsFor = (roles: ReadonlyArray<string>): ReadonlyArray<string> => {
      const out: Array<string> = []
      for (const [permission, allowed] of permissions()) {
        if (allowed.some((r) => roles.includes(r))) out.push(permission)
      }
      return out.sort()
    }

    /** Where the request came from, or "unknown" outside a request (a command, a test). */
    const caller = Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (r) =>
      Option.match(r, { onNone: () => "unknown", onSome: (req) => callerOf(req.headers, req.remoteAddress) }),
    )

    /**
     * Validate takes the registry as a VALUE, not as a tag to yield.
     *
     * The difference matters and cost an hour to find. `bearer` runs later, inside the
     * middleware's own context — which does not carry the registry. Yielding `Registry` inside
     * it fails at request time with "Service not found", while login (an ordinary handler,
     * which does have the registry) keeps working. So the service is resolved ONCE while the
     * layer is being built, and closed over.
     */
    // Owner, 2026-08-31: a refusal that says only "invalid or expired token" is why an hour was
    // lost to a session cookie two stacks were sharing. The four ways to fail are now four
    // different words, and they reach the log through the refusal body (kernel/refusal-log.ts).
    type Validated = { readonly user: CurrentUser["Type"] } | { readonly reason: string }

    const makeValidate =
      (registry: Context.Tag.Service<typeof Registry>) =>
      (token: string): Effect.Effect<Validated, never, never> =>
        Effect.gen(function* () {
          if (token === "") return { reason: "no token" }
          const th = sha256(token)
          // Filtered in SQL with a bound parameter and LIMIT 1, rather than reading every row
          // and searching in JavaScript. The old version parsed the entire session history on
          // every single request.
          const page = yield* store.page<Session>(SESSIONS, { offset: 0, limit: 1 }, { field: "tokenHash", value: th })
          const s = page.rows[0]
          // No row at all means this server never issued the token, or logout dropped it --
          // exactly the case a shared cookie produces, and the one worth naming separately.
          if (!s) return { reason: "unknown token" }
          if (new Date(s.expiresAt).getTime() <= Date.now()) return { reason: "expired token" }

          const summary = yield* registry.summary("Account", s.accountId)
          if (!summary) return { reason: "unknown account" }

          const roles = detail(summary, "roles")
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean)
          return {
            user: {
              id: summary.id,
              username: summary.title,
              roles,
              permissions: permissionsFor(roles),
              // The row's own id travels with the user: it is what makes per-session logout
              // possible (QWB-54, ticket 21) instead of logout-everywhere.
              sessionId: s.id,
            },
          }
        })

    // The implementation of the tag the kernel declares. The only place in the system that
    // decides who the current user is. With this cube absent, nobody satisfies the tag and the
    // server does not start.
    const AuthorizationLive = Layer.effect(
      Authorization,
      Effect.gen(function* () {
        const registry = yield* Registry
        const validate = makeValidate(registry)
        return Authorization.of({
          // The token arrives as `Redacted`, not a string — Effect hides it on purpose so it
          // cannot land in logs by accident. Unwrap explicitly.
          bearer: (token) =>
            Effect.gen(function* () {
              const result = yield* validate(Redacted.value(token))
              if (!("user" in result)) return yield* Effect.fail(new Unauthorized({ message: result.reason }))
              return result.user
            }),
        })
      }),
    )

    return {
      layers: AuthorizationLive,

      handlers: {
        login: ({ payload }: { payload: { username: string; password: string } }) =>
          Effect.gen(function* () {
            // Verification happens inside the cube that stores the credentials. This cube never
            // sees a hash — it gets an identity back, or nothing.
            const identity = credentials ? yield* credentials.verify(payload.username, payload.password) : undefined

            if (!identity) {
              // The refusal middleware logs the 401 itself; this line adds the one thing the
              // response does not carry -- WHICH username was tried. The password never appears.
              yield* Effect.logWarning(`auth-login-failed username=${payload.username} from=${yield* caller}`)
              return yield* Effect.fail(new Unauthorized({ message: "wrong username or password" }))
            }

            // Expired rows are dropped at login. Without this the sessions table only ever grew,
            // and every request paid for the whole history of logins.
            yield* dropExpiredSessions

            const token = randomBytes(32).toString("base64url")
            const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString()
            yield* store.insert(SESSIONS, "Session", "ses", {
              tokenHash: sha256(token),
              accountId: identity.id,
              expiresAt,
            })
            yield* bus.publish("auth.loggedIn", { accountId: identity.id, username: identity.username })
            // A session's start, visible. `token=` is the first 12 hex of sha256(token) -- the
            // SAME handle a later refusal prints, so "which session was thrown out" is one grep.
            yield* Effect.logInfo(
              `auth-login user=${identity.username} id=${identity.id} from=${yield* caller} ` +
                `token=${sha256(token).slice(0, 12)} expires=${expiresAt}`,
            )
            return { token, expiresAt }
          }),

        me: () =>
          Effect.gen(function* () {
            const u = yield* CurrentUser
            return { id: u.id, username: u.username, roles: u.roles, permissions: u.permissions }
          }),

        logout: () =>
          Effect.gen(function* () {
            // The middleware hands over the session id next to the user, so logout drops
            // EXACTLY the session the request came with: one row, found by its id (the
            // store's update is a bound-parameter lookup on id). A second device of the same
            // account keeps its session -- logout here means "this device", not "everywhere".
            const u = yield* CurrentUser
            yield* store.update(SESSIONS, u.sessionId, { deleted: true })
            yield* bus.publish("auth.loggedOut", { accountId: u.id })
            // The other end of the session. `session=` is the session row id, so "which
            // session was closed" joins this line with the row and the login line's token
            // handle. Closing one session drops exactly one row, every time.
            yield* Effect.logInfo(
              `auth-logout user=${u.username} id=${u.id} session=${u.sessionId} from=${yield* caller}`,
            )
            return { ok: true }
          }),
      },
    }
  },
})
