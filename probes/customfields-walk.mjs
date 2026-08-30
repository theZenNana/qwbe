// The customfields walk, phase 1 (QWB-46): split out of the probe driver because the file
// passed the size cap -- the rule is "split the file, never raise the cap".
//
// Covers: the definition lands, an unmounted cube is refused with a clear message, the value is
// saved through the CONTACT'S OWN API and folded into its row's `custom` sub-object, the
// definition still validates, and the cube's metadata publishes the custom field marked
// `custom: true`.

import { wait } from "./lib.mjs"

/**
 * Run the first half of the acceptance walk.
 *
 * `asAdmin` calls with the admin session; `reboot` restarts the server (proving persistence)
 * and returns a fresh admin caller, since sessions do not survive a restart.
 */
export const walkPhase1 = async ({ score, asAdmin, reboot }) => {
  const define = await asAdmin("/customfields", {
    method: "POST",
    body: JSON.stringify({ targetCube: "crm/contacts", name: "cnp", fieldType: "text", label: "CNP" }),
  })
  score.check(
    "a text field is defined on crm/contacts",
    define.status === 200 && define.body?.name === "cnp" && define.body?.targetCube === "crm/contacts",
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

  // ---- the value is saved through the CONTACT'S OWN API and folded into its row --------------
  const create = await asAdmin("/contacts", {
    method: "POST",
    body: JSON.stringify({ name: "Probe Contact", email: "probe@example.test", cnp: "123456789" }),
  })
  const contactId = create.body?.id
  score.check(
    "a contact is created with an undeclared field in the payload",
    create.status === 200 && Boolean(contactId) && create.body?.name === "Probe Contact",
    `http=${create.status}`,
  )

  const readBack = await asAdmin(`/contacts/${contactId}`)
  score.check(
    "the custom value reads back through the contact's own API, under custom",
    readBack.status === 200 && readBack.body?.custom?.cnp === "123456789",
    `http=${readBack.status} custom=${JSON.stringify(readBack.body?.custom)}`,
  )
  score.check(
    "the declared fields are untouched by the fold",
    readBack.body?.name === "Probe Contact" && readBack.body?.email === "probe@example.test",
    `name=${readBack.body?.name}`,
  )

  // ---- the definition still validates: a bad value is refused with a reason ------------------
  const bad = await asAdmin("/customfields/values", {
    method: "PUT",
    body: JSON.stringify({ cube: "crm/contacts", rowId: contactId, values: { cnp: "x".repeat(1001) } }),
  })
  score.check(
    "a value that breaks the definition is refused with 400 and a reason",
    bad.status === 400 && String(bad.body?.message).includes("cnp"),
    `http=${bad.status} message=${String(bad.body?.message).slice(0, 60)}`,
  )

  // ---- metadata: the custom field is published, marked custom --------------------------------
  let metadataField
  for (let i = 0; i < 10 && !metadataField; i++) {
    const meta = await asAdmin(`/catalog/${encodeURIComponent("crm/contacts")}/metadata`)
    metadataField = (meta.body?.fields ?? []).find((f) => f.name === "cnp")
    if (!metadataField) await wait(300)
  }
  score.check(
    "the cube's metadata publishes the active custom field, marked custom: true",
    metadataField?.custom === true && metadataField?.type === "string",
    `custom=${metadataField?.custom} type=${metadataField?.type}`,
  )

  return { contactId, asAdmin2: await reboot() }
}
