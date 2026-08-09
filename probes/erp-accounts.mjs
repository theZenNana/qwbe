// The accounts cube — common company records exposed as an API.
//
// Ordinary CRUD, and that is the point: a plugin's cube must behave exactly like one that ships
// with core. The two checks worth reading are the ones about what must NOT happen — an empty
// patch is refused rather than silently accepted, and `accountType` is stored without
// overwriting the row's own entity type.
//
// Returns the id it created: everything after this file hangs off that company.

export const accountsBehave = async ({ api, score, H }) => {
  // --- accounts ---
  const empty = await api.call("/accounts", { headers: H })
  score.check(
    "accounts list starts empty and paged",
    empty.status === 200 && empty.body?.total === 0,
    `total=${empty.body?.total}`,
  )

  const created = await api.call("/accounts", {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      name: "Public Demo SRL",
      phone: "000 000 001",
      website: "https://example.com",
      email: "office@example.com",
      industry: "Technology",
      rating: "Active",
      accountType: "Customer",
      employees: "24",
      annualRevenue: "1200000",
      billStreet: "Str. Aleea Ghirodei 1",
      billCity: "Timișoara",
      billCountry: "România",
      description: "Organizație demonstrativă.",
    }),
  })
  const accountId = created.body?.id
  score.check(
    "create an account → the submitted fields come back",
    created.status === 200 && created.body?.name === "Public Demo SRL",
    `id=${accountId}`,
  )
  score.check(
    "it is numbered from the ERP settings",
    created.body?.number === "ACC-0001",
    `number=${created.body?.number}`,
  )
  score.check(
    "`accountType` is stored without overwriting the row's entity type",
    created.body?.accountType === "Customer" && created.body?.type === "ErpAccount",
    `accountType=${created.body?.accountType} type=${created.body?.type}`,
  )

  const fetched = await api.call(`/accounts/${accountId}`, { headers: H })
  score.check(
    "read one account back",
    fetched.status === 200 && fetched.body?.billCity === "Timișoara",
    `city=${fetched.body?.billCity}`,
  )

  const patched = await api.call(`/accounts/${accountId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ phone: "000 000 002", rating: "Hot" }),
  })
  score.check(
    "patch changes only what it names",
    patched.status === 200 && patched.body?.phone === "000 000 002" && patched.body?.name === "Public Demo SRL",
    `phone=${patched.body?.phone} name kept`,
  )

  const emptyPatch = await api.call(`/accounts/${accountId}`, { method: "PATCH", headers: H, body: "{}" })
  score.check(
    "an empty patch is refused rather than silently accepted",
    emptyPatch.status === 400,
    `http=${emptyPatch.status}`,
  )

  const ghost = await api.call("/accounts/acct-deadbeef", {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ phone: "1" }),
  })
  score.check("patching a row that does not exist → 404", ghost.status === 404, `http=${ghost.status}`)

  return { accountId }
}
