// The customfields walk, phase 2 (QWB-46): split out of the probe driver because the file
// passed the size cap -- the rule is "split the file, never raise the cap".
//
// Covers: the values survive a RESTART (still in the row, read through the target's own API),
// the metadata STILL publishes the definitions after that restart (review fix 19 -- the
// assertion that would have caught the snapshot fix), and deleting a definition reports the
// value as an ORPHAN without deleting it.

export const walkPhase2 = async ({ score, asAdmin2, entryId, cube }) => {
  const readAfterRestart = await asAdmin2(`/${cube}/${entryId}`)
  score.check(
    "after a restart the values are still in the row, read through the target's own API",
    readAfterRestart.status === 200 &&
      readAfterRestart.body?.custom?.cnp === "123456789" &&
      readAfterRestart.body?.custom?.cnp2 === "987654321",
    `http=${readAfterRestart.status} custom=${JSON.stringify(readAfterRestart.body?.custom)}`,
  )

  // Review fix 19: the metadata check used to live only in phase 1, so a snapshot that came
  // back empty after a restart was invisible to this probe. Assert it again here.
  const meta = await asAdmin2(`/catalog/${encodeURIComponent(cube)}/metadata`)
  const metadataField = (meta.body?.fields ?? []).find((f) => f.name === "cnp")
  score.check(
    "after the restart the metadata still publishes the active custom field",
    metadataField?.custom === true,
    `custom=${metadataField?.custom} http=${meta.status}`,
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
