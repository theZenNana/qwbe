import { expect, it } from "@effect/vitest"
import { Effect, Option, Ref } from "effect"
import { lateBound, noIdentityDirectory } from "./late-bound-capabilities.ts"
import type { IdentityDirectory } from "./permissions-contracts.ts"

it.effect("answers the fallback until a provider is bound, then calls the provider", () =>
  Effect.gen(function* () {
    const bound = yield* Ref.make(Option.none<IdentityDirectory>())
    const directory = lateBound(bound, noIdentityDirectory)
    expect(yield* directory.resolveUsername("ana")).toBeUndefined()

    const provider: IdentityDirectory = {
      resolveUsername: (username) => Effect.succeed({ id: `id-${username}`, username }),
    }
    yield* Ref.set(bound, Option.some(provider))
    expect(yield* directory.resolveUsername("ana")).toEqual({ id: "id-ana", username: "ana" })
  }),
)
