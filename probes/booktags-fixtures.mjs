// The fixture half of the booktags probe: planting a pre-hierarchy database, and the
// behaviour checks that run against a booted server. Split on 2026-08-11 against the
// 6000-char file cap -- same rule as every other split in probes/.

import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** A FLAT bookmarks database as the pre-hierarchy server left it: same schema, same body
 *  shape, an id the run can look up afterwards. The kernel must rename, not transform. */
export const plantLegacyBookmarks = (dataDir) => {
  mkdirSync(dataDir, { recursive: true })
  const flat = new DatabaseSync(join(dataDir, "bookmarks.sqlite"))
  flat.exec(
    `CREATE TABLE "bookmarks" (id TEXT PRIMARY KEY, type TEXT NOT NULL, createdAt TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL)`,
  )
  flat
    .prepare(`INSERT INTO "bookmarks" (id, type, createdAt, deleted, body) VALUES (?, ?, ?, 0, ?)`)
    .run("bm-legacy01", "Bookmark", new Date().toISOString(), JSON.stringify({ label: "legacy", url: "https://old" }))
  flat.close()
}

export const migratedFiles = (dataDir) =>
  !existsSync(join(dataDir, "bookmarks.sqlite")) && existsSync(join(dataDir, "booktags--bookmarks.sqlite"))

const post = (api, H, path, body) => api.call(path, { method: "POST", headers: H, body: JSON.stringify(body) })

/** Behaviour checks: real-cube references, the setting over the bus, the switch masks. */
export const hierarchyBehaviour = async ({ api, score, H }) => {
  const bad = await post(api, H, "/bookmarks", { label: "x", targetCube: "nosuchcube" })
  score.check("a bookmark pointing at no mounted cube is refused", bad.status === 400, `http=${bad.status}`)
  const good = await post(api, H, "/bookmarks", { label: "notes", targetCube: "notes" })
  score.check("a bookmark pointing at a real cube is accepted", good.status === 200, `id=${good.body?.id}`)

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

  // The bus skips a switched-off subscriber, so a setting changed while bookmarks was down
  // would never arrive. The kernel announces the re-enablement on `qwbe/cube.enabled` and
  // the settings cube replays its current values -- the sequence below NEVER touches the
  // settings routes between the set and the create, so a masked GET cannot hide a miss.
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
