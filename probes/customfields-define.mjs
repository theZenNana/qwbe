// Sections 2 and 3: defining a field on somebody else's cube, and the merged view a form needs.
//
// Every refusal here is the interesting half. A name that is not an identifier, a cube that is
// not mounted, the same name twice, a select with no options, and -- the one that matters most --
// `customfields` adding a field to itself. A cube that can extend itself is a cube with no
// boundary left.
//
// Returns the two definitions that later sections change and delete.
export const definingFields = async ({ api, score, H, define, contactId }) => {
  // --- 2. defining fields ---
  const cnp = await define(
    { targetCube: "contacts", name: "cnp", label: "CNP", fieldType: "text", required: true, position: 1 },
    H,
  )
  score.check(
    "define a text field on another cube",
    cnp.status === 200 && cnp.body?.targetCube === "contacts",
    `id=${cnp.body?.id}`,
  )
  score.check(
    "an empty label falls back to the name",
    (await define({ targetCube: "notes", name: "urgency", fieldType: "number" }, H)).body?.label === "urgency",
    "label=urgency",
  )

  const seniority = await define(
    {
      targetCube: "contacts",
      name: "seniority",
      label: "Vechime",
      fieldType: "select",
      options: ["junior", "mid", "senior"],
      position: 2,
    },
    H,
  )
  const birthday = await define(
    { targetCube: "contacts", name: "birthday", label: "Zi de nastere", fieldType: "date", position: 3 },
    H,
  )
  const newsletter = await define({ targetCube: "contacts", name: "newsletter", fieldType: "bool", position: 4 }, H)
  score.check(
    "select, date and bool fields are defined too",
    [seniority, birthday, newsletter].every((r) => r.status === 200),
    `${[seniority, birthday, newsletter].map((r) => r.status).join(" ")}`,
  )

  score.check(
    "a name that is not an identifier is refused",
    (await define({ targetCube: "contacts", name: "nu e bun", fieldType: "text" }, H)).status === 400,
    "http=400",
  )
  const unknownCube = await define({ targetCube: "nuexista", name: "x", fieldType: "text" }, H)
  score.check(
    "a field on a cube that is not mounted is refused, and the message says what IS mounted",
    unknownCube.status === 400 && String(unknownCube.body?.message).includes("contacts"),
    `${String(unknownCube.body?.message).slice(0, 60)}...`,
  )
  score.check(
    "customfields cannot add fields to itself",
    (await define({ targetCube: "customfields", name: "x", fieldType: "text" }, H)).status === 400,
    "http=400",
  )
  score.check(
    "the same name twice on one cube is refused",
    (await define({ targetCube: "contacts", name: "cnp", fieldType: "text" }, H)).status === 400,
    "http=400",
  )
  score.check(
    "a select with no options is refused",
    (await define({ targetCube: "contacts", name: "x", fieldType: "select" }, H)).status === 400,
    "http=400",
  )

  // --- 3. the merged view a form needs ---
  const before = await api.call(`/customfields/values/contacts/${contactId}`, { headers: H })
  score.check(
    "a row's fields come back with definitions and empty values, in position order",
    before.body?.fields?.map((f) => f.name).join(",") === "cnp,seniority,birthday,newsletter",
    before.body?.fields?.map((f) => f.name).join(","),
  )
  score.check(
    "each field carries what a form needs to draw it",
    before.body?.fields?.[1]?.fieldType === "select" && before.body?.fields?.[1]?.options?.length === 3,
    `seniority: select with ${before.body?.fields?.[1]?.options?.length} options`,
  )

  return { seniority, birthday }
}
