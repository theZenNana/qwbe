import assert from "node:assert/strict"
import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { lookups } from "../../test-cube-tools.ts"
import { cube } from "./index.ts"

describe("account identity directory", () => {
  it.effect("resolves a username to public stable identity only", () =>
    Effect.gen(function* () {
      const account = {
        id: "acc-42",
        type: "Account",
        createdAt: "2026-08-14T00:00:00.000Z",
        deleted: false,
        username: "mihai",
        passwordHash: "must-not-cross-seam",
        displayName: "Mihai",
        email: "private@example.invalid",
        roles: ["admin"],
      }
      const store: CubeTools["store"] = {
        all: <A>() => Effect.succeed([account] as unknown as ReadonlyArray<A>),
        page: <A>() =>
          Effect.succeed({
            rows: [account] as unknown as ReadonlyArray<A>,
            total: 1,
            offset: 0,
            limit: 20,
            sortedBy: "createdAt",
          }),
        byId: <A>() => Effect.succeed(account as A),
        ...lookups(() => [account]),
        insert: () => Effect.succeed(account),
        update: () => Effect.succeed(account),
        count: () => Effect.succeed(1),
      }
      const identities = cube.create({
        store,
        bus: { publish: () => Effect.void },
        catalogue: () => [],
        permissions: () => new Map(),
        commands: () => [],
      }).identities
      assert.ok(identities)
      assert.deepEqual(yield* identities.resolveUsername("mihai"), {
        id: "acc-42",
        username: "mihai",
      })
      assert.deepEqual(Object.keys((yield* identities.resolveUsername("mihai")) ?? {}).sort(), ["id", "username"])
    }),
  )
})
