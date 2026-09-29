import { expect, it } from "@effect/vitest"
import { cloneSql } from "./seed-sql.ts"

it("clones a body table with deterministic ids and a unique body field; a serial id is left to its default", () => {
  const body = [
    { name: "id", hasDefault: false },
    { name: "created_at", hasDefault: false },
    { name: "body", hasDefault: false },
  ]
  const sql = cloneSql({ table: "crm--contacts.contacts", prefix: "cont", vary: "name" }, body, 10_000)
  expect(sql).toContain('INSERT INTO "crm--contacts"."contacts" ("id", "created_at", "body")')
  expect(sql).toContain("'cont' || '-bench' || g")
  expect(sql).toContain(`jsonb_set(t."body", '{name}'`)
  expect(sql).toContain("generate_series(1, 10000)")
  const serial = cloneSql(
    { table: "qwbe.activity" },
    [
      { name: "id", hasDefault: true },
      { name: "at", hasDefault: true },
    ],
    5,
  )
  expect(serial).toContain('("at") SELECT t."at" - g * interval')
})
