import * as Effect from "effect/Effect"
import { type CallOptions, call, login } from "../../src/api-client.ts"
import { boot, USERS } from "./boot.ts"
import { TestServer } from "./test-server.ts"

type Reply = ReturnType<typeof call>
type Method = NonNullable<CallOptions["method"]>

/** A logged-in caller: every request goes to its server with its token. */
export interface Session {
  readonly base: string
  readonly token: string
  readonly get: (path: string) => Reply
  readonly send: (method: Method, path: string, body?: unknown) => Reply
  readonly status: (path: string) => Effect.Effect<number, never, Effect.Effect.Context<Reply>>
  readonly switchCube: (cube: string, enabled: boolean) => Reply
}

const session = (base: string, token: string): Session => ({
  base,
  token,
  get: (path) => call(base, path, { token }),
  send: (method, path, body) => call(base, path, { method, token, body }),
  status: (path) => Effect.map(call(base, path, { token }), (reply) => reply.status),
  switchCube: (cube, enabled) =>
    call(base, `/settings/cubes/${encodeURIComponent(cube)}`, { method: "POST", token, body: { enabled } }),
})

/** Logs `user` in on `base` with the password the check server was booted with. */
export const sessionAs = (base: string, user: keyof typeof USERS) =>
  Effect.map(login(base, user, USERS[user]), (token) => session(base, token))

/** The admin on the file's TestServer. */
export const asAdmin = Effect.flatMap(TestServer, ({ base }) => sessionAs(base, "admin"))

/** The reader on the file's TestServer. */
export const asReader = Effect.flatMap(TestServer, ({ base }) => sessionAs(base, "reader"))

/** One boot over the workspace for the length of `step`, as admin; the server stops when it ends. */
export const bootedAsAdmin = <A, E, R>(step: (admin: Session) => Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.flatMap(boot(), (base) => Effect.flatMap(sessionAs(base, "admin"), step)))
