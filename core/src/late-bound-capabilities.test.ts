import { Effect, Option, Ref } from "effect"
import { expect, it } from "vitest"
import { lateBound, noIdentityDirectory } from "./late-bound-capabilities.ts"
import type { IdentityDirectory } from "./permissions-contracts.ts"

it("answers the fallback until a provider is bound, then calls the provider", async () => {
  const bound = Effect.runSync(Ref.make(Option.none<IdentityDirectory>()))
  const directory = lateBound(bound, noIdentityDirectory)
  expect(await Effect.runPromise(directory.resolveUsername("ana"))).toBeUndefined()

  const provider: IdentityDirectory = {
    resolveUsername: (username) => Effect.succeed({ id: `id-${username}`, username }),
  }
  Effect.runSync(Ref.set(bound, Option.some(provider)))
  expect(await Effect.runPromise(directory.resolveUsername("ana"))).toEqual({ id: "id-ana", username: "ana" })
})
