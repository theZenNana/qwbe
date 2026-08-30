// The customfields walk, phase 1 (QWB-46): split out of the probe driver because the file
// passed the size cap -- the rule is "split the file, never raise the cap".
//
// Covers: the definition lands, an unmounted cube is refused with a clear message, values are
// saved through the TARGET cube's own API and folded into its row's `custom` sub-object (a
// PATCH merge included -- review fix 21), the definition still validates, and the cube's
// metadata publishes the custom fields marked `custom: true`.

import { wait } from "./lib.mjs"

const CUBE = "guestbook"

/**
 * Run the first half of the acceptance walk.
 *
 * `asAdmin` calls with the admin session; `reboot` restarts the server and returns a fresh
 * admin caller, which the caller MUST use for the phase that follows (review fix 18).
 */
export const walkPhase1 = async ({ score, asAdmin, reboot }) => {
  const define = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: CUBE, name: "cnp", fieldType: "text", label: "CNP" }),
  })
  score.check(
    "a text field is defined on the target cube",
    define.status === 200 && define.body?.name === "cnp" && define.body?.targetCube === CUBE,
    `http=${define.status}`,
  )

  const refused = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: "nowhere/nothing", name: "ghost", fieldType: "text" }),
  })
  score.check(
    "a definition for a cube that is not mounted is refused with a clear message",
    refused.status === 400 && String(refused.body?.message).includes("nowhere/nothing"),
    `http=${refused.status} message=${refused.body?.message}`,
  )

  // ---- values are saved through the TARGET'S OWN API and folded into its row -----------------
  const create = await asAdmin(`/${CUBE}`, {
    method: "POST",
    body: JSON.stringify({ name: "Probe Entry", cnp: "123456789" }),
  })
  const entryId = create.body?.id
  score.check(
    "an entry is created with an undeclared field in the payload",
    create.status === 200 && Boolean(entryId) && create.body?.name === "Probe Entry",
    `http=${create.status}`,
  )

  const readBack = await asAdmin(`/${CUBE}/${entryId}`)
  score.check(
    "the custom value reads back through the target's own API, under custom",
    readBack.status === 200 && readBack.body?.custom?.cnp === "123456789",
    `http=${readBack.status} custom=${JSON.stringify(readBack.body?.custom)}`,
  )
  score.check(
    "the declared fields are untouched by the fold",
    readBack.body?.name === "Probe Entry",
    `name=${readBack.body?.name}`,
  )

  // ---- a PATCH adding a second value: the merge path, end to end (review fix 21) -------------
  // cnp2 needs its own definition first -- an undefined key is a 400 by design.
  const define2 = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: CUBE, name: "cnp2", fieldType: "text", label: "CNP 2" }),
  })
  score.check(
    "a second field is defined on the target cube",
    define2.status === 200 && define2.body?.name === "cnp2",
    `http=${define2.status}`,
  )
  const patched = await asAdmin(`/${CUBE}/${entryId}`, {
    method: "PATCH",
    body: JSON.stringify({ cnp2: "987654321" }),
  })
  score.check(
    "a PATCH adding a second custom value reports BOTH in its response",
    patched.status === 200 && patched.body?.custom?.cnp === "123456789" && patched.body?.custom?.cnp2 === "987654321",
    `http=${patched.status} custom=${JSON.stringify(patched.body?.custom)}`,
  )
  const afterPatch = await asAdmin(`/${CUBE}/${entryId}`)
  score.check(
    "the following GET still carries both custom values",
    afterPatch.body?.custom?.cnp === "123456789" && afterPatch.body?.custom?.cnp2 === "987654321",
    `custom=${JSON.stringify(afterPatch.body?.custom)}`,
  )

  // ---- the definition still validates, on BOTH write paths (review fix 2) -------------------
  const bad = await asAdmin("/customfields/values", {
    method: "PUT",
    body: JSON.stringify({ cube: CUBE, rowId: entryId, values: { cnp: "x".repeat(1001) } }),
  })
  score.check(
    "a value that breaks the definition is refused with 400 and a reason",
    bad.status === 400 && String(bad.body?.message).includes("cnp"),
    `http=${bad.status} message=${String(bad.body?.message).slice(0, 60)}`,
  )
  const wrongType = await asAdmin(`/${CUBE}`, {
    method: "POST",
    body: JSON.stringify({ name: "Bad Type", cnp: { nested: 1 } }),
  })
  score.check(
    "a value of the wrong type is refused by the target's own API, not stored",
    wrongType.status === 400,
    `http=${wrongType.status}`,
  )
  const ghost = await asAdmin(`/${CUBE}`, {
    method: "POST",
    body: JSON.stringify({ name: "Ghost", noSuchField: "x" }),
  })
  score.check(
    "an undefined key is rejected once definitions exist (the definition gate)",
    ghost.status === 400,
    `http=${ghost.status}`,
  )

  // ---- metadata: the custom field is published, marked custom --------------------------------
  let metadataField
  for (let i = 0; i < 10 && !metadataField; i++) {
    const meta = await asAdmin(`/catalog/${encodeURIComponent(CUBE)}/metadata`)
    metadataField = (meta.body?.fields ?? []).find((f) => f.name === "cnp")
    if (!metadataField) await wait(300)
  }
  score.check(
    "the cube's metadata publishes the active custom field, marked custom: true",
    metadataField?.custom === true && metadataField?.type === "string",
    `custom=${metadataField?.custom} type=${metadataField?.type}`,
  )

  return { entryId, asAdmin2: await reboot() }
}
