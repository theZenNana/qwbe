// Sections 7 to 10: changing a definition, who may do it, what is published, and switching off.
//
// The check worth reading is the resurrection one. Remove a field and define the same name again
// with a different type: it must come back EMPTY. A stored value surviving under a new type is
// how "date" quietly starts holding "29-02-1996" as text.
//
// Switching off is last on purpose — it proves the values survive the cube being disabled and
// re-enabled, which is only meaningful after something has written them.
export const changingAndSurface = async ({ api, score, H, define, setValues, contactId, seniority, birthday }) => {
  // --- 7. changing and removing a definition ---
  const patched = await api.call(`/customfields/${seniority.body?.id}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ label: "Nivel", position: 9 }),
  })
  score.check(
    "a definition's label and position can change",
    patched.status === 200 && patched.body?.label === "Nivel",
    `label=${patched.body?.label}`,
  )
  const afterMove = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "the form order follows the new position",
    afterMove.body?.fields?.map((f) => f.name).join(",") === "cnp,birthday,newsletter,seniority",
    afterMove.body?.fields?.map((f) => f.name).join(","),
  )
  score.check(
    "an empty patch is refused",
    (await api.call(`/customfields/${seniority.body?.id}`, { method: "PATCH", headers: H, body: "{}" })).status === 400,
    "http=400",
  )

  const removed = await api.call(`/customfields/${birthday.body?.id}`, { method: "DELETE", headers: H })
  const afterRemove = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "a field can be removed",
    removed.status === 200 && removed.body?.removed === "contacts.birthday",
    `removed=${removed.body?.removed}`,
  )
  score.check(
    "…and it disappears from the row's fields",
    !afterRemove.body?.fields?.some((f) => f.name === "birthday"),
    afterRemove.body?.fields?.map((f) => f.name).join(","),
  )
  const redefined = await define(
    { targetCube: "contacts", name: "birthday", label: "Zi de naștere", fieldType: "text" },
    H,
  )
  const afterRedefine = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "re-defining the same name starts EMPTY — an old value cannot come back under a new type",
    redefined.status === 200 && afterRedefine.body?.fields?.find((f) => f.name === "birthday")?.value === "",
    "no resurrection",
  )

  // --- 8. permissions ---
  const reader = await api.login("reader", "reader")
  score.check(
    "a reader may see the definitions",
    (await api.call("/customfields?limit=5", { headers: reader.headers })).status === 200,
    "http=200",
  )
  score.check(
    "a reader may not define a field",
    (await define({ targetCube: "notes", name: "x", fieldType: "text" }, reader.headers)).status === 403,
    "http=403",
  )
  score.check(
    "a reader may not fill one in",
    (await setValues("contacts", contactId, { cnp: "1" }, reader.headers)).status === 403,
    "http=403",
  )
  score.check("no token → 401", (await api.call("/customfields")).status === 401, "http=401")

  // --- 9. listing, CLI, contract ---
  const forContacts = await api.call("/customfields?cube=contacts&limit=50", { headers: H })
  score.check(
    "the list can be narrowed to one cube",
    forContacts.body?.rows?.every((r) => r.targetCube === "contacts") && forContacts.body?.total === 4,
    `${forContacts.body?.total} fields on contacts`,
  )
  const all = await api.call("/customfields?limit=50", { headers: H })
  score.check("…and unnarrowed it shows every cube's", all.body?.total === 5, `${all.body?.total} in total`)

  const cli = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "customfields:list contacts" }),
  })
  score.check(
    "the CLI lists them, with type and flags",
    cli.body?.ok === true && String(cli.body?.output).includes("contacts\tcnp\ttext\trequired"),
    String(cli.body?.output).split("\n")[0],
  )

  const spec = (await api.call("/openapi.json")).body
  const paths = Object.keys(spec?.paths ?? {})
  score.check(
    "the routes are published in the OpenAPI document",
    ["/customfields", "/customfields/{id}", "/customfields/values/{cube}/{rowId}"].every((p) => paths.includes(p)),
    `${paths.length} paths`,
  )

  // --- 10. switching it off ---
  await api.call("/settings/cubes/customfields", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ enabled: false }),
  })
  const off = await api.call("/customfields", { headers: H })
  score.check("switched off → 404, and the cubes it extended are untouched", off.status === 404, `http=${off.status}`)
  const contactsStillFine = await api.call("/contacts?limit=1", { headers: H })
  score.check(
    "the target cube carries on without it",
    contactsStillFine.status === 200,
    `http=${contactsStillFine.status}`,
  )
  await api.call("/settings/cubes/customfields", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ enabled: true }),
  })
  const backOn = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "switched back on → the values are still there",
    backOn.body?.fields?.find((f) => f.name === "cnp")?.value === "synthetic-cnp-01",
    "cnp kept across the switch",
  )
}
