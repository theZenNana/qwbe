// Fixtures and behaviour checks for the Booktags hierarchy probe.

import pg from "pg"
import { detailBehaviour } from "./booktags-detail-fixtures.mjs"

/**
 * Plant one flat, pre-hierarchy bookmarks SCHEMA. What was a SQLite file named
 * bookmarks.sqlite is a Postgres schema named "bookmarks" with the same table
 * -- the exact shape the kernel's data migration (a schema rename) expects to find.
 */
export const plantLegacyBookmarks = async (dbUrl) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    await c.query(`CREATE SCHEMA "bookmarks"`)
    await c.query(`CREATE TABLE "bookmarks"."bookmarks" (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, created_at timestamptz NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false, version INTEGER NOT NULL DEFAULT 1, body JSONB NOT NULL)`)
    await c.query(
      `INSERT INTO "bookmarks"."bookmarks" (id, type, created_at, deleted, version, body)
       VALUES ('bm-legacy01', 'Bookmark', now(), false, 1, $1)`,
      [JSON.stringify({ label: "legacy", url: "https://old" })],
    )
  } finally {
    await c.end()
  }
}

/** The migration happened when the flat schema is gone and the child's schema holds the row. */
export const migratedSchemas = async (dbUrl) => {
  const c = new pg.Client({ connectionString: dbUrl })
  await c.connect()
  try {
    const flat = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'bookmarks'`)
    const child = await c.query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = 'booktags--bookmarks'`)
    return flat.rowCount === 0 && child.rowCount === 1
  } finally {
    await c.end()
  }
}

const post = (api, H, path, body) => api.call(path, { method: "POST", headers: H, body: JSON.stringify(body) })

/** Behaviour checks: real-cube references, the setting over the bus, the switch masks. */
export const hierarchyBehaviour = async ({ api, score, H, readerHeaders, guestHeaders }) => {
  await detailBehaviour({ api, score, adminHeaders: H, readerHeaders, guestHeaders })

  await post(api, H, "/booktags-settings/enforceTargetCube", { value: "strict" })
  const withUrl = await post(api, H, "/bookmarks", { label: "y", targetCube: "notes", url: "https://x" })
  score.check(
    "strict mode set in booktags/settings makes the sibling refuse an arbitrary URL",
    withUrl.status === 400,
    `http=${withUrl.status}`,
  )
  const unknownSetting = await post(api, H, "/booktags-settings/nosuchkey", { value: "x" })
  score.check("an unknown setting is refused", unknownSetting.status === 404, `http=${unknownSetting.status}`)

  await post(api, H, "/settings/cubes/booktags", { enabled: false })
  const masked = await api.call("/bookmarks?limit=1", { headers: H })
  const maskedTags = await api.call("/tags?limit=1", { headers: H })
  const alive = await api.call("/notes?limit=1", { headers: H })
  score.check(
    "parent off -> every child's routes 404, standalone cubes unaffected",
    masked.status === 404 && maskedTags.status === 404 && alive.status === 200,
    `bookmarks=${masked.status} tags=${maskedTags.status} notes=${alive.status}`,
  )
  const maskedCli = await post(api, H, "/cli/exec", { line: "booktags/bookmarks:count" })
  score.check("parent off -> the child's commands vanish too", maskedCli.status === 400, `http=${maskedCli.status}`)

  await post(api, H, "/settings/cubes/booktags", { enabled: true })
  const back = await api.call("/bookmarks?limit=1", { headers: H })
  score.check("parent back on -> children return", back.status === 200, `http=${back.status}`)

  await post(api, H, "/settings/cubes/booktags%2Ftags", { enabled: false })
  const tagsOff = await api.call("/tags?limit=1", { headers: H })
  const bmOn = await api.call("/bookmarks?limit=1", { headers: H })
  score.check(
    "a child can be off alone while its sibling stays on",
    tagsOff.status === 404 && bmOn.status === 200,
    `tags=${tagsOff.status} bookmarks=${bmOn.status}`,
  )
  await post(api, H, "/settings/cubes/booktags%2Ftags", { enabled: true })

  // No settings GET between the write and create: recovery must come from the enable event.
  await post(api, H, "/settings/cubes/booktags%2Fbookmarks", { enabled: false })
  await post(api, H, "/booktags-settings/enforceTargetCube", { value: "relaxed" })
  await post(api, H, "/settings/cubes/booktags%2Fbookmarks", { enabled: true })
  const staleUrl = await post(api, H, "/bookmarks", { label: "z", targetCube: "notes", url: "https://x" })
  score.check(
    "a setting changed while bookmarks was off still reaches it (replay on re-enable)",
    staleUrl.status === 200,
    `http=${staleUrl.status}`,
  )
  await post(api, H, "/booktags-settings/enforceTargetCube", { value: "strict" })
}
