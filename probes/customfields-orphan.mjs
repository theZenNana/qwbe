// The customfields walk, phase 2: the orphan report and the restart-survival checks.
//
// Covers: the values survive a RESTART (still in the row, read through the target's own API),
// the metadata STILL publishes the definitions after that restart (review fix 19 -- the
// assertion that would have caught the snapshot fix), and deleting a definition reports the
// value as an ORPHAN without deleting it.

import { wait } from "./lib.mjs"

export const walkPhase2 = async ({ score, asAdmin2, entryId, cube }) => {
  const readAfterRestart = await asAdmin2(`/${cube}/${entryId}`)
  score.check(
    "after a restart the values are still in the row, read through the target's own API",
    readAfterRestart.status === 200 &&
      readAfterRestart.body?.custom?.cnp === "123456789" &&
      readAfterRestart.body?.custom?.cnp2 === "987654321",
    `http=${readAfterRestart.status} custom=${JSON.stringify(readAfterRestart.body?.custom)}`,
  )

  // A snapshot that comes back empty after a restart must be visible to THIS probe too, not
  // only to phase 1. Assert the metadata here as well.
  let metadataField
  for (let i = 0; i < 10 && !metadataField; i++) {
    const meta = await asAdmin2(`/catalog/${encodeURIComponent(cube)}/metadata`)
    metadataField = (meta.body?.fields ?? []).find((f) => f.name === "cnp")
    if (!metadataField) await wait(300)
  }
  score.check(
    "after the restart the metadata still publishes the active custom field",
    metadataField?.custom === true,
    `custom=${metadataField?.custom}`,
  )

  // ---- delete the definition: the values stay and are reported as orphans --------------------
  const defs = await asAdmin2("/customfields?limit=200")
  const cnpDef = (defs.body?.rows ?? []).find((d) => d.name === "cnp")
  const removed = await asAdmin2(`/customfields/${cnpDef?.id}`, { method: "DELETE" })
  score.check(
    "the definition is deleted",
    removed.status === 200 && removed.body?.removed === `${cube}.cnp`,
    `http=${removed.status}`,
  )

  const orphans = await asAdmin2(`/customfields/orphans?cube=${encodeURIComponent(cube)}`)
  const reported = (orphans.body?.orphans ?? []).find((o) => o.name === "cnp")
  score.check(
    "the deleted field's values are reported as orphans, on the same row",
    orphans.status === 200 && reported?.rowId === entryId && reported?.value === "123456789",
    `http=${orphans.status} orphan=${JSON.stringify(reported)}`,
  )

  const stillThere = await asAdmin2(`/${cube}/${entryId}`)
  score.check(
    "the orphaned value is still in the row -- deleting the definition deleted nothing",
    stillThere.status === 200 && stillThere.body?.custom?.cnp === "123456789",
    `http=${stillThere.status}`,
  )
}
