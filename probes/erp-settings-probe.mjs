// The ERP's own settings, and proof they are not decoration.
//
// A settings screen full of values nobody reads is a lie told in a place people trust. So each
// key is changed and then the NEXT record is created: the prefix must show up in its number, the
// default industry must show up on a company created without one. A stored value that changes
// nothing would pass a test that only checked the PUT came back 200.
//
// Paging rides along at the end because it depends on this section: the totals it asserts are
// the rows the settings checks created. Moving it earlier would make it assert a different
// number for the same reason.

export const settingsDoSomething = async ({ api, score, H }) => {
  // --- the ERP's own settings area, and proof it is not decoration ---
  const settings = await api.call("/erp-settings", { headers: H })
  const keys = (settings.body?.rows ?? []).map((r) => r.key).sort()
  score.check(
    "the ERP has its own settings area, seeded with its keys",
    settings.status === 200 && keys.join(",") === "erp.accountNumberPrefix,erp.contactNumberPrefix,erp.defaultIndustry",
    keys.join(" "),
  )

  const setPrefix = await api.call("/erp-settings/erp.accountNumberPrefix", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ value: "ORG" }),
  })
  score.check(
    "a setting can be changed",
    setPrefix.status === 200 && setPrefix.body?.value === "ORG",
    `value=${setPrefix.body?.value}`,
  )

  const afterPrefix = await api.call("/accounts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "A Doua Firmă" }),
  })
  score.check(
    "changing the prefix changes the very next account number — the setting is read, not stored for show",
    afterPrefix.body?.number === "ORG-0002",
    `number=${afterPrefix.body?.number}`,
  )

  await api.call("/erp-settings/erp.contactNumberPrefix", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ value: "PERS" }),
  })
  const afterContactPrefix = await api.call("/contacts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ lastName: "Ionescu" }),
  })
  score.check(
    "the same for contacts",
    afterContactPrefix.body?.number === "PERS-0003",
    `number=${afterContactPrefix.body?.number}`,
  )

  await api.call("/erp-settings/erp.defaultIndustry", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ value: "Retail" }),
  })
  const defaulted = await api.call("/accounts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Fără Industrie" }),
  })
  score.check(
    "a company created without an industry gets the ERP default",
    defaulted.body?.industry === "Retail",
    `industry=${defaulted.body?.industry}`,
  )
  const explicit = await api.call("/accounts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: "Cu Industrie", industry: "Banking" }),
  })
  score.check(
    "an explicit industry wins over the default",
    explicit.body?.industry === "Banking",
    `industry=${explicit.body?.industry}`,
  )

  const unknownKey = await api.call("/erp-settings/erp.nuExista", {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ value: "x" }),
  })
  score.check("an unknown settings key is refused, not created", unknownKey.status === 404, `http=${unknownKey.status}`)

  // --- paging and sorting, on the real SQL ---
  for (let i = 1; i <= 8; i++) {
    await api.call("/accounts", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ name: `Firma ${String(i).padStart(2, "0")}`, billCity: "Arad" }),
    })
  }
  const page = await api.call("/accounts?limit=3", { headers: H })
  score.check(
    "paging is real: 3 rows back, total counts everything",
    page.body?.rows?.length === 3 && page.body?.total === 12,
    `rows=${page.body?.rows?.length} total=${page.body?.total}`,
  )
  const sorted = await api.call("/accounts?limit=1&sortBy=name&descending=true", { headers: H })
  score.check(
    "sorting happens in SQL over a declared field",
    sorted.body?.rows?.[0]?.name === "Public Demo SRL",
    `first=${sorted.body?.rows?.[0]?.name}`,
  )
  const notSortable = await api.call("/accounts?limit=1&sortBy=description", { headers: H })
  score.check(
    "sorting by an undeclared field falls back and SAYS so",
    notSortable.body?.sortedBy === "createdAt",
    `asked description, sortedBy=${notSortable.body?.sortedBy}`,
  )
}
