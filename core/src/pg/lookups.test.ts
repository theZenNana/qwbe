// The SQL behind the store's `first`/`where` lookups (Qwbe#73), compiled with the Postgres
// dialect and run nowhere: no database. The runtime half is in store.test.ts.

import assert from "node:assert/strict"
import { describe, it } from "vitest"
import type { Where } from "../kernel/store-contract.ts"
import { compileOnly, newId, orderClause, whereClause } from "./rows.ts"
import { lookupIndexSql } from "./setup.ts"

const compiled = (where: Where) => {
  const [sql, params] = compileOnly`${whereClause(compileOnly, where)}`.compile()
  return { sql, params }
}

describe("whereClause for lookups", () => {
  it("binds one pair as a body field compared as text", () => {
    assert.deepEqual(compiled({ field: "username", value: "ana" }), {
      sql: "AND body ->> $1::text = $2::text",
      params: ["username", "ana"],
    })
  })

  it("ANDs several pairs, numbered in order", () => {
    assert.deepEqual(
      compiled([
        { field: "username", value: "ana" },
        { field: "status", value: "active" },
      ]),
      {
        sql: "AND body ->> $1::text = $2::text AND body ->> $3::text = $4::text",
        params: ["username", "ana", "status", "active"],
      },
    )
  })

  it("compares a meta column on the column, not inside the body", () => {
    assert.deepEqual(compiled({ field: "id", value: "acc-1" }), {
      sql: 'AND "id"::text = $1',
      params: ["acc-1"],
    })
  })

  it("still takes the full ListWhere", () => {
    assert.deepEqual(compiled({ equals: [{ field: "username", value: "ana" }], ids: ["a", "b"] }), {
      sql: "AND body ->> $1::text = $2::text AND id = ANY($3::text[])",
      params: ["username", "ana", ["a", "b"]],
    })
  })

  it("binds a body field in a set as one array", () => {
    assert.deepEqual(compiled({ in: [{ field: "entityId", values: ["e1", "e2"] }] }), {
      sql: "AND body ->> $1::text = ANY($2::text[])",
      params: ["entityId", ["e1", "e2"]],
    })
  })

  it("puts a meta column in a set on the column", () => {
    assert.deepEqual(compiled({ in: [{ field: "id", values: ["a"] }] }), {
      sql: 'AND "id"::text = ANY($1::text[])',
      params: [["a"]],
    })
  })

  it("matches nothing for an empty set", () => {
    assert.deepEqual(compiled({ in: [{ field: "entityId", values: [] }] }), { sql: "AND FALSE", params: [] })
  })

  it("bounds a body field by byte order, both ends inclusive", () => {
    assert.deepEqual(compiled({ range: { field: "timestamp", from: "2026-01-01", to: "2026-02-01" } }), {
      sql: 'AND (body ->> $1::text) COLLATE "C" >= $2::text AND (body ->> $3::text) COLLATE "C" <= $4::text',
      params: ["timestamp", "2026-01-01", "timestamp", "2026-02-01"],
    })
  })

  it("bounds one end only", () => {
    assert.deepEqual(compiled({ range: { field: "timestamp", to: "2026-02-01" } }), {
      sql: 'AND (body ->> $1::text) COLLATE "C" <= $2::text',
      params: ["timestamp", "2026-02-01"],
    })
  })
})

describe("orderClause", () => {
  it("sorts a body field by its jsonb value, ties oldest first", () => {
    const [sql, params] =
      compileOnly`${orderClause(compileOnly, "timestamp", true, new Set(["timestamp"])).sql}`.compile()
    assert.deepEqual({ sql, params }, { sql: "ORDER BY body -> $1 DESC, created_at ASC", params: ["timestamp"] })
  })
})

describe("lookupIndexSql", () => {
  it("builds a partial expression index on a plain field", () => {
    const ddl = lookupIndexSql("cube_account", "accounts", "username")
    assert.match(ddl, /^CREATE INDEX IF NOT EXISTS "accounts_username_idx" ON "cube_account"\."accounts"/)
    assert.match(ddl, /\(\(body ->> 'username'\)\) WHERE deleted = false$/)
  })

  it("refuses a field that would become SQL", () => {
    assert.throws(() => lookupIndexSql("s", "t", "x'); DROP TABLE t; --"), /lookup index field refused/)
  })

  it("refuses an empty field", () => {
    assert.throws(() => lookupIndexSql("s", "t", ""), /lookup index field refused/)
  })
})

// 32-bit ids collided past ~77,000 rows (permission_audit_pkey); 128 bits do not.
describe("newId", () => {
  it("is the prefix and 32 lower-case hex characters", () => {
    assert.match(newId("audit"), /^audit-[0-9a-f]{32}$/)
  })

  it("does not repeat in 100,000 ids", () => {
    const ids = new Set(Array.from({ length: 100_000 }, () => newId("x")))
    assert.equal(ids.size, 100_000)
  })
})
