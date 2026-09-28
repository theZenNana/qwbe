// The SQL behind the store's `first`/`where` lookups (Qwbe#73), compiled with the Postgres
// dialect and run nowhere: no database. The runtime half is in store.test.ts.

import assert from "node:assert/strict"
import { Effect } from "effect"
import { CurrentUser } from "qwbe-core/auth"
import { describe, it } from "vitest"
import { cube as notes } from "../cubes/notes/index.ts"
import { cube as views } from "../cubes/views/index.ts"
import type { Where } from "../kernel/store-contract.ts"
import { matchesWhere } from "../test-cube-tools.ts"
import { compileOnly, decode, newId, orderClause, whereClause } from "./rows.ts"
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

  it("matches nothing for an empty ids set", () => {
    assert.deepEqual(compiled({ ids: [] }), { sql: "AND FALSE", params: [] })
    assert.equal(matchesWhere({ id: "a" }, { ids: [] }), false)
  })

  // A list without `?ids=` (or with an empty one) must not reach the store as an empty set.
  for (const [name, list, permission] of [
    ["notes", notes, "notes:read"],
    ["views", views, "views:read"],
  ] as const) {
    it(`${name} list without ids filters nothing`, async () => {
      const asked: Array<Where> = []
      const store = {
        page: (_t: string, p: { offset: number; limit: number }, where: Where) =>
          Effect.sync(() => {
            asked.push(where)
            return { rows: [], total: 0, offset: p.offset, limit: p.limit, sortedBy: "createdAt" }
          }),
      }
      const { handlers } = list.create({ store, bus: {}, entityPermissions: {} } as never) as unknown as {
        handlers: { list: (request: unknown) => Effect.Effect<unknown, unknown, CurrentUser> }
      }
      const user = { id: "u", username: "u", roles: ["reader"], permissions: [permission], sessionId: "s" }
      for (const urlParams of [{}, { ids: "" }, { ids: " , " }]) {
        await Effect.runPromise(
          handlers
            .list({ urlParams: { offset: 0, limit: 10, ...urlParams } })
            .pipe(Effect.provideService(CurrentUser, user)),
        )
      }
      assert.deepEqual(
        asked.map((where) => compiled(where).sql),
        ["", "", ""],
      )
      assert.ok(asked.every((where) => matchesWhere({ id: "a" }, where)))
    })
  }

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

  it("ORs groups, each group ANDed, a meta column on the column", () => {
    assert.deepEqual(
      compiled({
        anyOf: [
          {
            equals: [
              { field: "team", value: "red" },
              { field: "type", value: "person" },
            ],
          },
          { in: [{ field: "username", values: ["ana"] }] },
        ],
      }),
      {
        sql: 'AND ((body ->> $1::text = $2::text AND "type"::text = $3) OR (body ->> $4::text = ANY($5::text[])))',
        params: ["team", "red", "person", "username", ["ana"]],
      },
    )
  })

  it("matches nothing for an empty anyOf", () => {
    assert.deepEqual(compiled({ anyOf: [] }), { sql: "AND FALSE", params: [] })
  })

  it("negates a group, keeping rows where it is NULL (a missing field)", () => {
    assert.deepEqual(
      compiled({ equals: [{ field: "team", value: "red" }], not: { equals: [{ field: "id", value: "x" }] } }),
      {
        sql: 'AND body ->> $1::text = $2::text AND ("id"::text = $3) IS NOT TRUE',
        params: ["team", "red", "x"],
      },
    )
  })

  it("never turns a group value into SQL text", () => {
    const hostile = "x'); DROP TABLE t; --"
    const { sql, params } = compiled({ not: { equals: [{ field: hostile, value: hostile }] } })
    assert.equal(sql.includes("DROP"), false)
    assert.deepEqual(params, [hostile, hostile])
  })
})

// The in-memory store's reading of the same groups, so cube unit tests see the SQL meaning.
describe("matchesWhere with anyOf and not", () => {
  const ana = { id: "p-1", username: "ana", team: "red" }
  const bo = { id: "p-2", username: "bo" }

  it("keeps a row when some group matches, and none for no groups", () => {
    const where = { anyOf: [{ equals: [{ field: "team", value: "blue" }] }, { ids: ["p-1"] }] }
    assert.equal(matchesWhere(ana, where), true)
    assert.equal(matchesWhere(bo, where), false)
    assert.equal(matchesWhere(ana, { anyOf: [] }), false)
  })

  it("negates a group, keeping a row missing its field", () => {
    const where = { not: { equals: [{ field: "team", value: "red" }] } }
    assert.equal(matchesWhere(ana, where), false)
    assert.equal(matchesWhere(bo, where), true)
  })
})

describe("orderClause", () => {
  const order = (sortBy: string | undefined, descending: boolean) => {
    const [sql, params] =
      compileOnly`${orderClause(compileOnly, sortBy, descending, new Set(["timestamp"])).sql}`.compile()
    return { sql, params }
  }

  // Missing keys sit where a null key would: first ascending, last descending.
  it("sorts a body field by its stored sort key as bytes, then by id", () => {
    assert.deepEqual(order("timestamp", true), {
      sql: `ORDER BY (body -> '_sort' -> 'k' ->> $1) COLLATE "C" DESC NULLS LAST, id DESC`,
      params: ["timestamp"],
    })
    assert.deepEqual(order("timestamp", false), {
      sql: `ORDER BY (body -> '_sort' -> 'k' ->> $1) COLLATE "C" ASC NULLS FIRST, id ASC`,
      params: ["timestamp"],
    })
  })

  it("breaks a created_at tie by id in the same direction", () => {
    assert.deepEqual(order(undefined, true), { sql: "ORDER BY created_at DESC, id DESC", params: [] })
    assert.deepEqual(order("secret", false), { sql: "ORDER BY created_at ASC, id ASC", params: [] })
  })

  it("breaks a meta column tie by id, and needs none when sorting by id", () => {
    assert.deepEqual(order("type", false), { sql: 'ORDER BY "type" ASC, id ASC', params: [] })
    assert.deepEqual(order("id", true), { sql: 'ORDER BY "id" DESC', params: [] })
  })
})

describe("decode", () => {
  it("strips the reserved sort keys, so no caller ever sees them", () => {
    const row = decode({
      id: "x-1",
      type: "x",
      created_at: new Date("2026-01-01T00:00:00Z"),
      deleted: false,
      body: { name: "a", _sort: { v: 1, k: { name: "361" } } },
    })
    assert.deepEqual(row, { id: "x-1", type: "x", createdAt: "2026-01-01T00:00:00.000Z", deleted: false, name: "a" })
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
