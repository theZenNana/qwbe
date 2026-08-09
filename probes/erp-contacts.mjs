// The contacts cube, and the link a third party declared.
//
// Two claims that look like one. First, a contact is a person attached to a company by a plain
// id — no join and no import. Second, the relationship between them is
// declared in `spaces/erp/`, by neither cube, so the company page grows a contacts group without
// `accounts` ever hearing the word.
//
// The `title` check is here because of a real screen bug: the generic detail page reads
// `row.title` as the NAME of the record, so a contact came up headed "Director tehnic". The
// field is `jobTitle`, and this pins the rename so it cannot quietly come undone.

export const contactsAndTheLink = async ({ api, score, H, accountId }) => {
  // --- contacts, with the company as a plain id ---
  const contact = await api.call("/contacts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      salutation: "Dl.",
      firstName: "Ionel",
      lastName: "Popescu",
      accountId,
      jobTitle: "Director tehnic",
      department: "IT",
      phone: "000 000 003",
      mobile: "000 000 004",
      email: "ionel.popescu@example.com",
      leadSource: "Cold Call",
      mailingCity: "Timișoara",
      mailingCountry: "România",
      doNotCall: false,
      emailOptOut: true,
    }),
  })
  const contactId = contact.body?.id
  score.check(
    "create a contact attached to a company",
    contact.status === 200 && contact.body?.accountId === accountId,
    `id=${contactId}`,
  )
  score.check(
    "it is numbered from the ERP settings too",
    contact.body?.number === "CON-0001",
    `number=${contact.body?.number}`,
  )
  score.check(
    "the consent flags are stored as booleans",
    contact.body?.emailOptOut === true && contact.body?.doNotCall === false,
    "emailOptOut=true doNotCall=false",
  )

  const unattached = await api.call("/contacts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ lastName: "Fără Firmă" }),
  })
  score.check(
    "a contact may exist without a company — a lead before its record",
    unattached.status === 200 && unattached.body?.accountId === "",
    `accountId="${unattached.body?.accountId}"`,
  )

  const contactPatched = await api.call(`/contacts/${contactId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ jobTitle: "Director general" }),
  })
  score.check(
    "patch a contact",
    contactPatched.status === 200 && contactPatched.body?.jobTitle === "Director general",
    `jobTitle=${contactPatched.body?.jobTitle}`,
  )
  // The job title is `jobTitle`, not `title`: the generic detail page reads `row.title` as the
  // NAME of the record, so a contact's page came up headed "Director tehnic". Checked here so the
  // rename cannot quietly come undone.
  score.check(
    "a contact's row has no `title` field to hijack the screen's heading",
    !("title" in (contactPatched.body ?? {})),
    "fields: jobTitle, not title",
  )
  score.check(
    "the display name is derived, and stays derived after a patch",
    contactPatched.body?.name === "Dl. Ionel Popescu",
    `name=${contactPatched.body?.name}`,
  )
  const renamed = await api.call(`/contacts/${contactId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ lastName: "Popescu-Marin" }),
  })
  score.check(
    "renaming the person renames the display name with it",
    renamed.body?.name === "Dl. Ionel Popescu-Marin",
    `name=${renamed.body?.name}`,
  )
  await api.call(`/contacts/${contactId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ lastName: "Popescu" }),
  })
  const notAccepted = await api.call(`/contacts/${contactId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ name: "Cine Vreau Eu" }),
  })
  score.check(
    "a caller cannot set the derived name directly",
    notAccepted.status === 400,
    `http=${notAccepted.status} — \`name\` is not in the payload schema`,
  )

  // --- the link, declared in spaces/erp/ by neither cube ---
  const links = await api.call(`/links/ErpAccount/${accountId}`, { headers: H })
  const group = links.body?.groups?.find((g) => g.cube === "contacts")
  score.check(
    "the company's page gets a contacts group with a total, no rows fetched",
    group?.total === 1 && group?.label === "contacts",
    `group total=${group?.total}`,
  )

  const groupRows = await api.call(`/links/ErpAccount/${accountId}/contacts?limit=10`, { headers: H })
  score.check(
    "the group's rows are the contacts' own chosen summary",
    groupRows.body?.rows?.[0]?.title === "Dl. Ionel Popescu",
    `first row: ${groupRows.body?.rows?.[0]?.title}`,
  )

  const parentLinks = await api.call(`/links/ErpContact/${contactId}`, { headers: H })
  const parent = parentLinks.body?.parents?.find((p) => p.field === "accountId")
  score.check(
    "the contact's page resolves its company through the registry, without a join",
    parent?.to === "ErpAccount" && parent?.summary?.title === "Public Demo SRL",
    `${parent?.field} → ${parent?.summary?.title}`,
  )

  return { contactId }
}
