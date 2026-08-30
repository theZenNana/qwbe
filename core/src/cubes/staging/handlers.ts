// The staging handlers. Split from index.ts for the size cap: this file carries the behaviour,
// index.ts the registration. The store arrives narrowed to the batch capability -- see
// batch.ts for why that capability exists and how it stays inside the cube's own schema.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { requirePermission } from "../../kernel/auth-contract.ts"
import { BadRequest, NotFound } from "../../kernel/errors.ts"
import type { BatchStore } from "./batch.ts"
import { type SetCreate, MAX_CHUNK_CHARS, type StagingSet as StagingSetRow, TABLES } from "./contract.ts"
import { applyChunk } from "./import-chunks.ts"
import { profileHandler } from "./profile-run.ts"

type Store = CubeTools["store"]

const loadSet = (store: Store, id: string) =>
  Effect.gen(function* () {
    const row = (yield* store.byId(TABLES.sets, id)) as StagingSetRow | undefined
    if (!row) return yield* Effect.fail(new NotFound({ message: `staging set ${id} does not exist` }))
    return row
  })

const toState = (row: StagingSetRow) => ({
  id: row.id,
  name: row.name,
  format: row.format,
  sourceFile: row.sourceFile,
  state: row.state,
  rowCount: row.rowCount,
  malformedCount: row.malformedCount,
  malformedSample: row.malformedSample,
  sensitiveFields: row.sensitiveFields,
  createdAt: row.createdAt,
})

export const stagingHandlers = (tools: CubeTools, batched: BatchStore) => {
  const { store, bus } = tools
  return {
    handlers: {
      createSet: ({ payload }: { payload: typeof SetCreate.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:write")
          const row = (yield* store.insert(TABLES.sets, "staging.set", "set", {
            name: payload.name,
            format: payload.format,
            sourceFile: payload.sourceFile,
            state: "importing",
            rowCount: 0,
            malformedCount: 0,
            malformedSample: [],
            sensitiveFields: payload.sensitiveFields,
          })) as StagingSetRow
          yield* bus.publish("staging.set.created", { id: row.id, name: row.name })
          return toState(row)
        }),

      listSets: () =>
        Effect.gen(function* () {
          yield* requirePermission("staging:read")
          // store.all already filters deleted = false; no second filter here.
          const rows = (yield* store.all(TABLES.sets)) as ReadonlyArray<StagingSetRow>
          return rows.map(toState)
        }),

      getSet: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:read")
          const row = yield* loadSet(store, path.id)
          return toState(row)
        }),

      chunk: ({ path, payload }: { path: { id: string }; payload: { text: string; startLine: number } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:write")
          const set = yield* loadSet(store, path.id)
          if (set.state !== "importing") {
            return yield* Effect.fail(new BadRequest({ message: `set ${set.id} is ${set.state}, not importing` }))
          }
          if (payload.text.length > MAX_CHUNK_CHARS) {
            return yield* Effect.fail(
              new BadRequest({ message: `chunk is ${payload.text.length} chars, the cap is ${MAX_CHUNK_CHARS} -- split the file` }),
            )
          }
          yield* store.count(TABLES.rows) // first touch creates the table
          const applied = applyChunk(set, payload.text, payload.startLine)
          // A batch that throws must not leave the set `importing` forever: the state flips to
          // `failed` in the SAME breath as the error propagates, so a half-imported set never
          // reports as importable-or-complete (QWB-45 review, blocker 4). The error itself
          // still surfaces as a defect -- the caller sees the 500, the set sees the state.
          yield* batched.batch(applied.statements).pipe(
            Effect.tapError(() => store.update(TABLES.sets, set.id, { state: "failed" })),
          )
          return { parsed: applied.parsed, malformed: applied.malformed }
        }),

      finish: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:write")
          const set = yield* loadSet(store, path.id)
          // Only an importing set can be finished: `done` on a failed (or already done) set
          // would stamp completion over a half-import (QWB-45 review, blocker 4).
          if (set.state !== "importing") {
            return yield* Effect.fail(new BadRequest({ message: `set ${set.id} is ${set.state}, not importing` }))
          }
          yield* store.update(TABLES.sets, set.id, { state: "done" })
          return { id: set.id, state: "done" }
        }),

      sensitive: ({ path, payload }: { path: { id: string }; payload: { fields: ReadonlyArray<string> } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:write")
          const set = yield* loadSet(store, path.id)
          yield* store.update(TABLES.sets, set.id, { sensitiveFields: payload.fields })
          return { id: set.id, sensitiveFields: payload.fields }
        }),

      profile: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:read")
          const set = yield* loadSet(store, path.id)
          // The rows table is created lazily; profile's batch does not create it, so touch it
          // first or a set with no chunk ever posted 500s with "relation rows does not exist"
          // (QWB-45 review, item 11).
          yield* store.count(TABLES.rows)
          return yield* profileHandler(batched, set)
        }),

      deleteSet: ({ path }: { path: { id: string } }) =>
        Effect.gen(function* () {
          yield* requirePermission("staging:write")
          const set = yield* loadSet(store, path.id)
          // First touch creates BOTH tables -- the batch below only deletes from them, and on
          // a process where no chunk was ever posted the rows table would not exist (item 11).
          yield* store.count(TABLES.sets)
          yield* store.count(TABLES.rows)
          // ONE transaction: a set half-deleted while its rows survive is the failure this
          // endpoint exists to make impossible.
          yield* batched.batch([
            { text: `DELETE FROM "${TABLES.rows}" WHERE body->>'setId' = $1`, values: [set.id] },
            { text: `DELETE FROM "${TABLES.sets}" WHERE id = $1`, values: [set.id] },
          ])
          return { removed: set.id }
        }),
    },
  }
}
