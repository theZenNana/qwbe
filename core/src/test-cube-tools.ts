// Shared unit-test helper (QWB-69). Extracted from the `memoryStore` copies that lived in
// permissions/index.test.ts, echo/auth.test.ts and views/auth.test.ts -- the ponytail note in
// views/auth.test.ts said to extract on a third copy, and the cube test gate made six.
// In-memory store only: Postgres stays out of unit tests by design, exactly as the existing
// cube tests state.

import { Array as Arr, Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { ListWhere } from "./kernel/pagination.ts"
import type { Where } from "./kernel/store-contract.ts"

type Row = Record<string, unknown>

/**
 * A store `Where` read in memory with the SQL meaning of rows.ts `whereClause`: every pair ANDed
 * and compared as text (`body ->> field`, a missing field never matches), `ids` as a set (empty:
 * none), `q` as a
 * case-insensitive prefix on any of its fields, `anyOf` as some group matching (none for no
 * groups), `not` as the group failing -- a missing field fails it, as `IS NOT TRUE` does in SQL.
 */
export const matchesWhere = (row: Row, where: Where): boolean => {
  const w = asListWhere(where)
  return (
    equalsAll(row, w.equals) &&
    inIds(row, w.ids) &&
    inSets(row, w.in) &&
    matchesQ(row, w.q) &&
    (w.anyOf === undefined || w.anyOf.some((g) => matchesWhere(row, g))) &&
    (w.not === undefined || !matchesWhere(row, w.not))
  )
}

const asListWhere = (where: Where): ListWhere => {
  if (Array.isArray(where)) return { equals: where }
  if ("field" in where) return { equals: [where] }
  return where as ListWhere
}

/** `body ->> field`: objects as JSON text, a missing or null field as no text at all. */
const fieldText = (row: Row, field: string): string | undefined => {
  const value = row[field]
  if (value === undefined || value === null) return undefined
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

const equalsAll = (row: Row, equals: ListWhere["equals"] = []): boolean =>
  equals.every((e) => fieldText(row, e.field) === e.value)

const inIds = (row: Row, ids: ListWhere["ids"]): boolean => ids === undefined || ids.includes(String(row.id))

// An empty set matches nothing, and a missing field no set, as in rows.ts.
const inSets = (row: Row, sets: ListWhere["in"] = []): boolean =>
  sets.every((s) => {
    const text = fieldText(row, s.field)
    return text !== undefined && s.values.includes(text)
  })

const matchesQ = (row: Row, q: ListWhere["q"]): boolean => {
  if (!q?.text || q.fields.length === 0) return true
  const prefix = q.text.toLowerCase()
  return q.fields.some((field) => fieldText(row, field)?.toLowerCase().startsWith(prefix))
}

/** The store's `first`/`where` over in-memory rows: deleted rows out, insertion (oldest) order, limit. */
export const lookups = (rows: (table: string) => ReadonlyArray<Row>): Pick<CubeTools["store"], "first" | "where"> => {
  const matching = <A>(table: string, where: Where) =>
    rows(table).filter((row) => row.deleted !== true && matchesWhere(row, where)) as ReadonlyArray<A>
  return {
    first: <A>(table: string, where: Where) => Effect.succeed(Arr.head(matching<A>(table, where))),
    where: <A>(table: string, where: Where, opts?: Parameters<CubeTools["store"]["where"]>[2]) =>
      Effect.succeed(matching<A>(table, where).slice(0, opts?.limit)),
  }
}

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
  // `page` and `count` skip deleted rows like Postgres; `all`/`byId` keep them for tests that inspect soft deletes.
  const live = (table: string) => rows(table).filter((row) => row.deleted !== true)
  return {
    all: <A>(table: string) => Effect.succeed(rows(table) as ReadonlyArray<A>),
    page: <A>(table: string, page: { offset: number; limit: number }, where?: unknown) => {
      const pair = where as { field: string; value: unknown } | undefined
      const hit = pair && "field" in pair ? live(table).filter((row) => row[pair.field] === pair.value) : live(table)
      return Effect.succeed({
        rows: hit.slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
        total: hit.length,
        offset: page.offset,
        limit: page.limit,
        sortedBy: "createdAt",
      })
    },
    byId: <A>(table: string, id: string) => Effect.succeed(rows(table).find((row) => row.id === id) as A | undefined),
    ...lookups(rows),
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
    count: (table: string) => Effect.succeed(live(table).length),
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

/** Base CubeTools shell: store + bus, everything else empty. Cast through unknown on purpose:
 * the shell omits the optional capabilities; each test adds the ones its cube asks for. */
export const baseTools = (): CubeTools => ({
  store: memoryStore(),
  bus: recordingBus(),
  catalogue: () => [],
  permissions: () => new Map(),
  commands: () => [],
})

/** A CurrentUser with sensible defaults; pass overrides for the fields a test cares about. */
export const currentUser = (
  overrides: Partial<{
    id: string
    username: string
    roles: ReadonlyArray<string>
    permissions: ReadonlyArray<string>
    sessionId: string
  }> = {},
) => ({
  id: "acc-1",
  username: "ana",
  roles: ["reader"] as ReadonlyArray<string>,
  permissions: [] as ReadonlyArray<string>,
  sessionId: "ses-1",
  ...overrides,
})
