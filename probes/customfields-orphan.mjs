// The customfields walk, phase 2 (QWB-46): split out of the probe driver because the file
// passed the size cap -- the rule is "split the file, never raise the cap".
//
// Covers: the value survives a RESTART (still in the row, read through the contact's own API),
// and deleting the definition reports the value as an ORPHAN without deleting it.

export const walkPhase2 = async ({ score, asAdmin2, contactId }) => {
  const readAfterRestart = await asAdmin2(`/contacts/${contactId}`)
  score.check(
    "after a restart the value is still in the row, read through the contact's own API",
    readAfterRestart.status === 200 && readAfterRestart.body?.custom?.cnp === "123456789",
    `http=${readAfterRestart.status} custom=${JSON.stringify(readAfterRestart.body?.custom)}`,
  )

  // ---- delete the definition: the value stays and is reported as an orphan -------------------
  const defs = await asAdmin2("/customfields?limit=200")
  const cnpDef = (defs.body?.rows ?? []).find((d) => d.name === "cnp")
  const removed = await asAdmin2(`/customfields/${cnpDef?.id}`, { method: "DELETE" })
  score.check(
    "the definition is deleted",
    removed.status === 200 && removed.body?.removed === "crm/contacts.cnp",
    `http=${removed.status}`,
  )

  const orphans = await asAdmin2(`/customfields/orphans?cube=${encodeURIComponent("crm/contacts")}`)
  const reported = (orphans.body?.orphans ?? []).find((o) => o.name === "cnp")
  score.check(
    "the deleted field's value is reported as an orphan, on the same row",
    orphans.status === 200 && reported?.rowId === contactId && reported?.value === "123456789",
    `http=${orphans.status} orphan=${JSON.stringify(reported)}`,
  )

  const stillThere = await asAdmin2(`/contacts/${contactId}`)
  score.check(
    "the orphaned value is still in the row -- deleting the definition deleted nothing",
    stillThere.status === 200 && stillThere.body?.custom?.cnp === "123456789",
    `http=${stillThere.status}`,
  )
}
