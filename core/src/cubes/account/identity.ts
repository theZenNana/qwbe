import { Effect, Option } from "effect"
import type { CubeTools, IdentityDirectory } from "qwbe-core/cube"

type AccountIdentity = Readonly<{ id: string; username: string }>

export const identityDirectory = (store: CubeTools["store"], seed: Effect.Effect<void>): IdentityDirectory => ({
  resolveUsername: (username) =>
    Effect.gen(function* () {
      yield* seed
      const found = yield* store.first<AccountIdentity>("accounts", { field: "username", value: username })
      return Option.getOrUndefined(Option.map(found, (a) => ({ id: a.id, username: a.username })))
    }),
})
