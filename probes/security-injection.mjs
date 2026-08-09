// Sections 1, 1b, 1c and 1d: what arrives through the query string, and what must not come back.
//
// One theme, four angles. The claim under attack is that table names are interpolated but come
// from manifests, while everything a caller sends is bound as a parameter — so user input never
// reaches interpolated SQL, and no hidden column becomes readable through the ordering.
//
// A passing check means the attack FAILED. That is the outcome we want, but only if the attack
// was real: a 500 counts as a refusal, data loss or leakage does not.

const INJECTIONS = [
  `id"; DROP TABLE notes; --`,
  `id) ; DELETE FROM notes; --`,
  `title" COLLATE NOCASE, (SELECT 1 FROM sqlite_master) "`,
  `'||(SELECT group_concat(name) FROM sqlite_master)||'`,
  `id LIMIT 1 -- `,
]

/** `Math.trunc` keeps NaN and Infinity, which reached the SQLite bind as a 500. */
const NASTY_OFFSETS = ["NaN", "1e400", "99999999999999999999", "-Infinity"]

export const injectionAndLeaks = async ({ api, score, H }) => {
  // ============ 1. SQL through `sortBy` ============
  let allSurvived = true
  let detail = ""
  for (const evil of INJECTIONS) {
    const r = await api.call(`/notes?limit=5&sortBy=${encodeURIComponent(evil)}`, { headers: H })
    // A 500 is acceptable — refusing is fine. Data loss or leakage is not.
    if (r.status === 200 && r.body?.total !== 1) {
      allSurvived = false
      detail = `total became ${r.body?.total} after sortBy=${evil.slice(0, 30)}`
      break
    }
  }
  const afterInjection = await api.call("/notes?limit=5", { headers: H })
  score.check(
    "SQL: five injection attempts through `sortBy` change nothing",
    allSurvived && afterInjection.status === 200 && afterInjection.body?.total === 1,
    allSurvived ? `row still there, total=${afterInjection.body?.total}` : detail,
  )

  // The table must still exist — a dropped table would surface as an error on the next call.
  score.check("SQL: the notes table survived", afterInjection.status === 200, `http=${afterInjection.status}`)

  // ============ 1b. the leak two reviewers found, from the reader's side ============
  //
  // A `reader` account must not be able to obtain the administrator's password hash. It used to:
  // `account` put `passwordHash` into its public registry summary so `auth` could check a
  // password, and `links` served that summary to anyone holding `links:read`.
  const reader0 = await api.login("reader", "reader")
  const notesList = await api.call("/notes?limit=1", { headers: reader0.headers })
  const someNote = notesList.body?.rows?.[0]?.id

  if (someNote) {
    const asReader = await api.call(`/links/Note/${someNote}`, { headers: reader0.headers })
    const parentDetails = (asReader.body?.parents ?? []).flatMap((p) => p.summary?.details ?? [])
    score.check(
      "leak: a reader cannot obtain a password hash through the registry summary",
      !parentDetails.some((d) => d.key === "passwordHash"),
      `details exposed: ${JSON.stringify(parentDetails.map((d) => d.key))}`,
    )
  }

  const wholeBody = JSON.stringify(await api.call("/account?limit=10", { headers: reader0.headers }))
  score.check(
    "leak: no hash anywhere in the account listing either",
    !wholeBody.includes("passwordHash") && !/[a-f0-9]{64}/.test(wholeBody),
    "no 64-hex string in the response",
  )

  // ============ 1c. sortBy that used to crash ============
  const badSort = await api.call('/notes?sortBy="', { headers: H })
  score.check(
    "sortBy: a malformed field is a 400 with a reason, not a 500 with an empty body",
    badSort.status === 400,
    `http=${badSort.status}`,
  )

  const bracketSort = await api.call("/notes?sortBy=%5B0%5D", { headers: H })
  score.check("sortBy: `[0]` is refused too", bracketSort.status === 400, `http=${bracketSort.status}`)

  // Ordering reads the stored row, not the response — so a hidden column was an oracle even
  // after the summary leak was closed. Only fields a cube publishes as sortable are honoured.
  const sortByHidden = await api.call("/account?sortBy=passwordHash&limit=10", { headers: reader0.headers })
  const sortByDefault = await api.call("/account?limit=10", { headers: reader0.headers })
  score.check(
    "sortBy: a field the cube does not publish as sortable is not honoured",
    sortByHidden.status === 200 &&
      JSON.stringify(sortByHidden.body?.rows?.map((r) => r.id)) ===
        JSON.stringify(sortByDefault.body?.rows?.map((r) => r.id)),
    "ordering by passwordHash gives the default order, so it reveals nothing",
  )

  // …and it is not honoured SILENTLY: the response says what ordering was actually applied.
  // Swallowing the request would be the same defect this prototype refuses at the CLI gate.
  score.check(
    "sortBy: the response reports the ordering actually applied, so the caller is not misled",
    sortByHidden.body?.sortedBy === "createdAt",
    `asked passwordHash, response says sortedBy=${sortByHidden.body?.sortedBy}`,
  )

  const sortByAllowed = await api.call("/account?sortBy=username&descending=true&limit=10", {
    headers: reader0.headers,
  })
  score.check(
    "sortBy: a published field still sorts, and is reported as applied",
    sortByAllowed.body?.rows?.[0]?.username === "reader" && sortByAllowed.body?.sortedBy === "username",
    `first row: ${sortByAllowed.body?.rows?.[0]?.username}, sortedBy=${sortByAllowed.body?.sortedBy}`,
  )

  // ============ 1d. the capability leak two rounds of review closed ============
  //
  // `commands()` used to hand every cube the actual `run` function of every command. A cube
  // declaring no permissions could call `account:list` with no token and no session, and
  // `dependency-cruiser` reported nothing, because nothing forbidden had been imported. The
  // dispatcher now lives in the kernel and checks the caller's permissions inside itself.
  const commandList = await api.call("/cli/commands", { headers: H })
  const anyCommand = (commandList.body ?? [])[0]
  score.check(
    "commands: cubes see metadata only — no `run` function is handed out",
    !!anyCommand && !("run" in anyCommand),
    `fields exposed: ${Object.keys(anyCommand ?? {}).join(", ")}`,
  )

  let offsetsOk = true
  let offsetDetail = ""
  for (const o of NASTY_OFFSETS) {
    const r = await api.call(`/notes?offset=${encodeURIComponent(o)}`, { headers: H })
    if (r.status >= 500) {
      offsetsOk = false
      offsetDetail = `offset=${o} → ${r.status}`
      break
    }
  }
  score.check(
    "paging: NaN, 1e400 and huge offsets never reach the database as a 500",
    offsetsOk,
    offsetsOk ? "all four handled" : offsetDetail,
  )
}
