// Everything around the two cubes: who may touch them, how they reach the CLI, what happens
// when one is switched off, whether the contract is published, and who knows whom.
//
// The last part is the one that cannot be checked over HTTP. A passing request proves the system
// works; it proves nothing about whether `contacts` has the word `ErpAccount` written inside it.
// So the source is read, with comments stripped — a word in a comment is not knowledge of a cube.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { coreDir } from "./lib.mjs"

const pluginDir = join(coreDir, "plugins", "erp-pack", "cubes")
const read = (cube) => readFileSync(join(pluginDir, cube, "index.ts"), "utf8")

/** Comments stripped, so only code counts. */
const codeOf = (cube) =>
  read(cube)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")

export const theSurfaceAround = async ({ api, score, H, contactId }) => {
  // --- permissions, per role, from the manifests ---
  const reader = await api.login("reader", "reader")
  const readerReads = await api.call("/accounts?limit=1", { headers: reader.headers })
  const readerWrites = await api.call("/accounts", {
    method: "POST",
    headers: reader.headers,
    body: JSON.stringify({ name: "Nu Trebuie" }),
  })
  score.check("a reader may read the ERP", readerReads.status === 200, `http=${readerReads.status}`)
  score.check("a reader may not write to it", readerWrites.status === 403, `http=${readerWrites.status}`)
  const readerSetting = await api.call("/erp-settings/erp.accountNumberPrefix", {
    method: "PUT",
    headers: reader.headers,
    body: JSON.stringify({ value: "HACK" }),
  })
  score.check("a reader may not change ERP settings", readerSetting.status === 403, `http=${readerSetting.status}`)

  const noToken = await api.call("/accounts")
  score.check("no token → 401, from the contract's own middleware", noToken.status === 401, `http=${noToken.status}`)

  // --- the CLI, aggregated from the manifests ---
  const commands = (await api.call("/cli/commands", { headers: H })).body ?? []
  score.check(
    "the ERP's commands join the CLI without the cli cube knowing it exists",
    ["accounts:count", "accounts:list", "contacts:count", "contacts:list", "erp-settings:show"].every((n) =>
      commands.some((c) => c.name === n),
    ),
    `${commands.length} commands in total`,
  )
  const count = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "accounts:count" }),
  })
  score.check("running one gives the real number", count.body?.output === "12", `output=${count.body?.output}`)
  const show = await api.call("/cli/exec", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ line: "erp-settings:show" }),
  })
  score.check(
    "the settings command shows the current values",
    String(show.body?.output).includes("erp.accountNumberPrefix\tORG"),
    "erp.accountNumberPrefix=ORG",
  )

  // --- switching the ERP off ---
  await api.call("/settings/cubes/accounts", { method: "POST", headers: H, body: JSON.stringify({ enabled: false }) })
  const offRoutes = await api.call("/accounts?limit=1", { headers: H })
  const offLinks = await api.call(`/links/ErpContact/${contactId}`, { headers: H })
  score.check("switching `accounts` off → its routes 404", offRoutes.status === 404, `http=${offRoutes.status}`)
  score.check(
    "…and the contact's company link goes with it, rather than erroring",
    (offLinks.body?.parents ?? []).length === 0,
    `parents=${JSON.stringify(offLinks.body?.parents ?? [])}`,
  )
  await api.call("/settings/cubes/accounts", { method: "POST", headers: H, body: JSON.stringify({ enabled: true }) })
  const backOn = await api.call("/accounts?limit=1", { headers: H })
  score.check("switched back on → the ERP returns", backOn.status === 200, `http=${backOn.status}`)

  // --- the contract is published ---
  const spec = (await api.call("/openapi.json")).body
  const paths = Object.keys(spec?.paths ?? {})
  score.check(
    "the ERP routes are in the emitted OpenAPI, so the frontend needs no hand-written types",
    ["/accounts", "/accounts/{id}", "/contacts", "/contacts/{id}", "/erp-settings", "/erp-settings/{key}"].every((p) =>
      paths.includes(p),
    ),
    `${paths.length} paths published`,
  )

  // --- decoupling, read from the source rather than inferred from a passing request ---
  const contactsCode = codeOf("contacts")
  const accountsCode = codeOf("accounts")
  score.check(
    "`contacts` never names the entity it points at",
    !contactsCode.includes("ErpAccount"),
    'grep "ErpAccount" in contacts/index.ts → nothing (accountId is an id, not knowledge)',
  )
  score.check(
    "`accounts` does not know contacts exist",
    !/contact/i.test(accountsCode),
    'grep -i "contact" in accounts/index.ts → nothing',
  )
  score.check(
    "neither ERP cube imports another cube",
    ![contactsCode, accountsCode, codeOf("erp-settings")].some((c) => /from\s+["'][^"']*cubes\//.test(c)),
    "every import goes to src/kernel/ or a package",
  )
  const spaceFile = readFileSync(join(coreDir, "src", "spaces", "erp", "index.ts"), "utf8")
  score.check(
    "the link between them is declared by a third party, in a space",
    spaceFile.includes('from: "contacts"') && spaceFile.includes('to: "ErpAccount"'),
    "spaces/erp/index.ts holds both names; neither cube holds the other's",
  )
}
