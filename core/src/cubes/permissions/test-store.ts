// The memory store with a `page` that filters by the full ListWhere and orders like the Postgres
// store (kernel/sort-key.ts keys compared as bytes, then `id`), for the paged visibility list.
// ponytail: lives here because test-cube-tools.ts `page` honours one pair only; move it there
// when a second cube pages by ListWhere in unit tests.

import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { PageRequest } from "../../kernel/pagination.ts"
import { sortKey } from "../../kernel/sort-key.ts"
import { memoryStore } from "../../test-cube-tools.ts"

type Row = Record<string, unknown>

const byBytes = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

export const pagingStore = (): CubeTools["store"] => {
  const store = memoryStore()
  return {
    ...store,
    page: <A>(table: string, page: PageRequest, where?: Parameters<CubeTools["store"]["page"]>[2]) =>
      Effect.map(store.where<Row>(table, where ?? []), (hit) => {
        const field = page.sortBy ?? "createdAt"
        const sign = page.descending ? -1 : 1
        const sorted = [...hit].sort(
          (a, b) => sign * (byBytes(sortKey(a[field]), sortKey(b[field])) || byBytes(String(a.id), String(b.id))),
        )
        return {
          rows: sorted.slice(page.offset, page.offset + page.limit) as ReadonlyArray<A>,
          total: sorted.length,
          offset: page.offset,
          limit: page.limit,
          sortedBy: field,
        }
      }),
  }
}
