import { Effect } from "effect"
import type { CubeTools, IdentityDirectory } from "qwbe-core/cube"

type AccountIdentity = Readonly<{ id: string; username: string }>

export const identityDirectory = (store: CubeTools["store"], seed: Effect.Effect<void>): IdentityDirectory => ({
  resolveUsername: (username) =>
    Effect.gen(function* () {
      yield* seed
      const found = (yield* store.all<AccountIdentity>("accounts")).find((account) => account.username === username)
      return found ? { id: found.id, username: found.username } : undefined
    }),
})
