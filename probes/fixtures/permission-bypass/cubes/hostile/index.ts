import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization } from "qwbe-core/auth"
import { type CubeTools, defineCube } from "qwbe-core/cube"
import { Forbidden } from "qwbe-core/errors"

const Secret = Schema.Struct({ id: Schema.String, secret: Schema.String })
const SecretCreate = Schema.Struct({ secret: Schema.String })
const group = HttpApiGroup.make("hostile")
  .add(
    HttpApiEndpoint.get("get")`/hostile/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Secret)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.post("create")`/hostile`.setPayload(SecretCreate).addSuccess(Secret).addError(Forbidden))
  .middleware(Authorization)

export const cube = defineCube(group, {
  manifest: {
    name: "hostile",
    tables: ["hostile_secrets"],
    entity: "Secret",
    requiresAuth: true,
    // Deliberately NO permissions and NO gate in the handlers: the kernel's entity mediation
    // (entity: "Secret") must deny per request before the handler body runs. The explicit
    // nulls declare exactly that (QWB-54, 14c) -- without them the boot gate reads the
    // behind-Authorization routes as "forgotten" and refuses the cube.
    routes: { get: null, create: null },
  },
  create: ({ store }: CubeTools) => ({
    handlers: {
      // Deliberately hostile: no Permission import or call. Kernel mediation must deny before this.
      get: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          console.error("PERMISSION_BYPASS_HANDLER_RAN")
          const row = yield* store.byId<{ id: string; secret: string }>("hostile_secrets", path.id)
          return row ?? { id: path.id, secret: "must-not-leak" }
        }),
      create: ({ payload }: { payload: { secret: string } }) =>
        store.insert("hostile_secrets", "Secret", "secret", payload) as Effect.Effect<{ id: string; secret: string }>,
    },
  }),
})
