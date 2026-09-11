// Shared unit-test helper (QWB-69). Extracted from the `memoryStore` copies that lived in
// permissions/index.test.ts, echo/auth.test.ts and views/auth.test.ts -- the ponytail note in
// views/auth.test.ts said to extract on a third copy, and the cube test gate made six.
// In-memory store only: Postgres stays out of unit tests by design, exactly as the existing
// cube tests state.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"

export const memoryStore = (): CubeTools["store"] => {
  const tables = new Map<string, Array<Record<string, unknown>>>()
  let next = 0
  const rows = (table: string) => {
    const found = tables.get(table)
    if (found) return found
    const created: Array<Record<string, unknown>> = []
    tables.set(table, created)
    return created
  }
  return {
    all: <A>(table: string) => Effect.succeed(rows(table) as ReadonlyArray<A>),
    page: <A>(table: string, page: { offset: number; limit: number }, where?: unknown) => {
      const pair = where as { field: string; value: unknown } | undefined
      const hit = pair && "field" in pair ? rows(table).filter((row) => row[pair.field] === pair.value) : rows(table)
      return Effect.succeed({
        rows: hit.slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
        total: hit.length,
        offset: page.offset,
        limit: page.limit,
        sortedBy: "createdAt",
      })
    },
    byId: <A>(table: string, id: string) => Effect.succeed(rows(table).find((row) => row.id === id) as A | undefined),
    insert: (table: string, type: string, prefix: string, values: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = { id: `${prefix}-${++next}`, type, createdAt: new Date().toISOString(), deleted: false, ...values }
        rows(table).push(row)
        return row
      }),
    update: (table: string, id: string, patch: Record<string, unknown>) =>
      Effect.sync(() => {
        const row = rows(table).find((candidate) => candidate.id === id)
        if (!row) return undefined
        Object.assign(row, patch)
        return row
      }),
    count: (table: string) => Effect.succeed(rows(table).length),
  }
}

/** A publishable bus that records events for assertions. */
export const recordingBus = () => {
  const events: Array<{ topic: string; payload: unknown }> = []
  return {
    events,
    publish: (topic: string, payload: unknown) => {
      events.push({ topic, payload })
      return Effect.void
    },
  }
}

/** Base CubeTools shell: store + bus, everything else empty. Not asserted here: eslint no-unnecessary-type-assertion
 * flags the cast; tests provide the extra capability fields themselves. */
export const baseTools = (): CubeTools =>
  ({
    store: memoryStore(),
    bus: recordingBus(),
    catalogue: () => [],
    permissions: () => new Map(),
    commands: () => [],
  }) as unknown as CubeTools
