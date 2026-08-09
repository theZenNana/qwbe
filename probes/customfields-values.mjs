// Sections 4, 5 and 6: writing values, and the three ways that must not go wrong.
//
// Strictly — every field type refuses what it cannot hold, and says which values it would have
// taken. All or nothing — one bad value in a write stores NONE of the good ones, checked by
// re-reading rather than by trusting the 400. And per row — values belong to the row they were
// written for, and are NOT in the target cube's own row.
//
// That last one is a LIMIT stated as a check rather than left in a comment: because the values
// live elsewhere, a list cannot be sorted or filtered by a custom field. Written down so nobody
// discovers it as a bug.
export const writingValues = async ({ api, score, H, setValues, contactId }) => {
  // --- 4. writing values, strictly ---
  const written = await setValues(
    "contacts",
    contactId,
    { cnp: "synthetic-cnp-01", seniority: "senior", birthday: "1996-02-29", newsletter: "true" },
    H,
  )
  score.check(
    "valid values are stored and come back merged",
    written.status === 200 && written.body?.fields?.find((f) => f.name === "seniority")?.value === "senior",
    `seniority=${written.body?.fields?.find((f) => f.name === "seniority")?.value}`,
  )

  const reread = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "they survive a re-read",
    reread.body?.fields?.find((f) => f.name === "cnp")?.value === "synthetic-cnp-01",
    "cnp kept",
  )

  score.check(
    "a name that is not a field on that cube is refused",
    (await setValues("contacts", contactId, { nuexista: "x" }, H)).status === 400,
    "http=400",
  )
  const badNumber = await setValues("notes", "note-whatever", { urgency: "foarte" }, H)
  score.check(
    "a number field refuses a word, and says so",
    badNumber.status === 400 && String(badNumber.body?.message).includes("must be a number"),
    String(badNumber.body?.message),
  )
  const badDate = await setValues("contacts", contactId, { birthday: "29-02-1996" }, H)
  score.check(
    "a date field insists on YYYY-MM-DD",
    badDate.status === 400 && String(badDate.body?.message).includes("YYYY-MM-DD"),
    "http=400",
  )
  score.check(
    "a bool field takes only true or false",
    (await setValues("contacts", contactId, { newsletter: "da" }, H)).status === 400,
    "http=400",
  )
  const badOption = await setValues("contacts", contactId, { seniority: "principal" }, H)
  score.check(
    "a select refuses a value outside its options, and lists them",
    badOption.status === 400 && String(badOption.body?.message).includes("junior, mid, senior"),
    String(badOption.body?.message).slice(0, 70),
  )
  score.check(
    "a required field cannot be emptied",
    (await setValues("contacts", contactId, { cnp: "" }, H)).status === 400,
    "http=400",
  )

  // --- 5. all or nothing ---
  const partial = await setValues("contacts", contactId, { seniority: "mid", birthday: "nu e data" }, H)
  const afterPartial = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "a write with one bad value stores NONE of the good ones",
    partial.status === 400 && afterPartial.body?.fields?.find((f) => f.name === "seniority")?.value === "senior",
    `seniority still ${afterPartial.body?.fields?.find((f) => f.name === "seniority")?.value}`,
  )

  // --- 6. values belong to one row, and not to the target's row ---
  const other = await api.call("/contacts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Altcineva" }),
  })
  const otherFields = await api.call(`/customfields/values/contacts/${other.body?.id}`, { headers: H })
  score.check(
    "another row of the same cube starts empty",
    otherFields.body?.fields?.every((f) => f.value === ""),
    "no values leak between rows",
  )
  const targetRow = await api.call(`/contacts/${contactId}`, { headers: H })
  score.check(
    "the custom values are NOT in the target cube's own row — the honest limit, stated as a check",
    !JSON.stringify(targetRow.body).includes("synthetic-cnp-01"),
    "so a list cannot be sorted or filtered by a custom field",
  )
}
