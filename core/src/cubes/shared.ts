// Helpers the core cubes share. Not a cube (the scanner reads directories only) and not a
// public `qwbe-core/*` export: plugin packs keep their own copies.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { SummaryRow } from "qwbe-core/entity"
import type { PageRequest } from "qwbe-core/pagination"

/**
 * A tool the manifest asked for, or a boot failure naming it. The kernel grants a tool exactly
 * when the manifest declares it, so this only fires on a kernel bug; failing at startup beats a
 * 500 on the first request. `create` is synchronous, hence a throw rather than an Effect.
 */
export const requireTool = <T>(tool: T | undefined, message: string): T => {
  if (tool === undefined) throw new Error(message)
  return tool
}

/** The `relational` part of a cube whose rows live in one store table. */
export const storeRelational = <Row extends { readonly deleted?: boolean }>(
  store: CubeTools["store"],
  table: string,
  summary: (row: Row) => SummaryRow,
  before: Effect.Effect<void> = Effect.void,
) => {
  const live = (id: string) => Effect.map(store.byId<Row>(table, id), (row) => (row && !row.deleted ? row : undefined))
  return {
    search: (field: string, value: string, page: PageRequest, only: "all" | ReadonlySet<string> = "all") =>
      Effect.gen(function* () {
        // Empty `ids` means "no filter" to the store.
        if (only !== "all" && only.size === 0) return { rows: [], total: 0 }
        yield* before
        const p = yield* store.page<Row>(table, page, {
          equals: [{ field, value }],
          ...(only === "all" ? {} : { ids: [...only] }),
        })
        return { rows: p.rows.map(summary), total: p.total }
      }),
    summaryById: (id: string) => Effect.map(live(id), (row) => (row ? summary(row) : undefined)),
    fieldValue: (id: string, field: string) =>
      Effect.map(live(id), (row) => {
        const v = row ? (row as Record<string, unknown>)[field] : null
        return typeof v === "string" ? v : null
      }),
  }
}
