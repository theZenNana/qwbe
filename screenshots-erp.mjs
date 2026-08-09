// Screenshots of the ERP, so a person can look at it with their eyes.
//
//   node screenshots-erp.mjs
//   QWBE_SHOTS_DIR=/somewhere/else node screenshots-erp.mjs
//
// Tests do not catch what is ugly, and a list of passing checks is not a screen. This starts the
// API and the Next app itself, fills them with generic demonstration records, and
// walks the pages a person would actually click: the company list, one company with its contacts
// group, one contact pointing back, and the ERP's own settings area.
//
// Both processes are stopped at the end. They live in whatever sandbox this script runs in —
// which is exactly why the evidence is produced here rather than by asking someone else to look.
//
// It lives at the repo root, next to `screenshots.mjs`, and NOT inside the plugin — where it
// started. `dependency-cruiser` refused it there, correctly: nothing under `plugins/` may import
// `node:fs` or `node:child_process`, and a screenshot script needs both. The rule caught a file
// in the wrong place rather than a bad import.
//
// REQUIRES erp-pack MOUNTED — it is not, by default, and this script does not mount it. Measured
// on 3 Aug: `/accounts` answers 404 with an EMPTY body, so the first `post` dies on
// `JSON.parse("")` before a single screenshot is taken. erp-pack sits in `core/store/` (the
// shelf) while `core/plugins/` (what the kernel reads at startup) has crm-pack — and installing
// erp-pack over it is refused on purpose, because both bring a cube called `contacts`.
// `probes/erp.mjs` does the whole dance (crm-pack out, erp-pack in, restart, put crm-pack back
// from git); this script does not, so run it after that pack is actually mounted.
// Said plainly here so the next person reads a prerequisite, not a regression they caused.

import { openStage } from "./screenshots-lib.mjs"

// The scaffolding — API up, logged in, Next up, browser open — lives in screenshots-lib.mjs, so
// what stays here is the only part worth reading: which records this screen needs, and which
// pages a person would click through.
const stage = await openStage({
  slug: "erp",
  ports: [4540, 4541],
  wipe: ["erp_accounts", "erp_contacts", "erp_settings", "accounts", "contacts", "erp-settings"],
})
const { WEB, page, post, shot } = stage

const companies = [
  {
    name: "Public Demo SRL",
    industry: "Technology",
    accountType: "Customer",
    rating: "Active",
    phone: "000 000 001",
    email: "office@example.com",
    website: "https://example.com",
    employees: "24",
    annualRevenue: "1200000",
    billStreet: "Aleea Ghirodei 1",
    billCity: "Timișoara",
    billCountry: "România",
  },
  {
    name: "Hidro Instal SA",
    industry: "Construction",
    accountType: "Prospect",
    rating: "Warm",
    phone: "000 000 005",
    email: "contact@hidroinstal.test",
    billCity: "Arad",
    billCountry: "România",
    employees: "120",
  },
  {
    name: "Agro Vest SRL",
    industry: "Agriculture",
    accountType: "Customer",
    rating: "Cold",
    phone: "000 000 006",
    email: "office@agrovest.test",
    billCity: "Oradea",
    billCountry: "România",
    employees: "48",
  },
  {
    name: "Nord Logistic",
    industry: "Transportation",
    accountType: "Vendor",
    rating: "Active",
    phone: "000 000 007",
    email: "dispecerat@nordlogistic.test",
    billCity: "Cluj-Napoca",
    billCountry: "România",
    employees: "310",
  },
]
const created = []
for (const c of companies) created.push(await post("/accounts", c))

const people = [
  {
    salutation: "Dl.",
    firstName: "Ionel",
    lastName: "Popescu",
    jobTitle: "Director tehnic",
    department: "IT",
    phone: "000 000 003",
    mobile: "000 000 004",
    email: "ionel.popescu@example.com",
    leadSource: "Cold Call",
    mailingCity: "Timișoara",
    mailingCountry: "România",
    at: 0,
  },
  {
    salutation: "Dna.",
    firstName: "Maria",
    lastName: "Ionescu",
    jobTitle: "Contabil șef",
    department: "Financiar",
    phone: "000 000 008",
    email: "maria.ionescu@example.com",
    leadSource: "Existing Customer",
    mailingCity: "Timișoara",
    mailingCountry: "România",
    emailOptOut: true,
    at: 0,
  },
  {
    salutation: "Dl.",
    firstName: "Andrei",
    lastName: "Marin",
    jobTitle: "Achiziții",
    phone: "000 000 009",
    email: "andrei.marin@hidroinstal.test",
    leadSource: "Web Site",
    mailingCity: "Arad",
    mailingCountry: "România",
    at: 1,
  },
  {
    salutation: "Dna.",
    firstName: "Elena",
    lastName: "Toma",
    jobTitle: "Manager depozit",
    phone: "000 000 010",
    email: "elena.toma@agrovest.test",
    leadSource: "Partner",
    mailingCity: "Oradea",
    mailingCountry: "România",
    doNotCall: true,
    at: 2,
  },
  {
    salutation: "Dl.",
    firstName: "Radu",
    lastName: "Barbu",
    jobTitle: "Șef flotă",
    phone: "000 000 011",
    email: "radu.barbu@nordlogistic.test",
    leadSource: "Trade Show",
    mailingCity: "Cluj-Napoca",
    mailingCountry: "România",
    at: 3,
  },
]
const contacts = []
for (const { at, ...p } of people) contacts.push(await post("/contacts", { ...p, accountId: created[at].id }))

try {
  await page.goto(WEB, { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "sign in" }).click()
  await page.waitForSelector("text=What is mounted")
  await shot("1-catalog-cu-erp")

  await page.locator("nav.bara").locator("[data-cube='accounts']").click()
  await page.waitForSelector("text=Public Demo SRL")
  await shot("2-lista-accounts")

  await page.locator("tbody tr", { hasText: "Public Demo SRL" }).getByRole("link").first().click()
  await page.waitForSelector("text=/contacts \\(2\\)/")
  await shot("3-account-detaliu-cu-contacte")

  await page.locator("nav.bara").locator("[data-cube='contacts']").click()
  await page.waitForSelector("text=Popescu")
  await shot("4-lista-contacts")

  await page.locator("tbody tr", { hasText: "Popescu" }).getByRole("link").first().click()
  await page.waitForSelector("text=Public Demo SRL")
  await shot("5-contact-detaliu-cu-firma")

  await page.locator("nav.bara").locator("[data-cube='erp-settings']").click()
  await page.waitForSelector("text=erp.accountNumberPrefix")
  await shot("6-setari-erp")

  await page.getByRole("link", { name: "terminal" }).click()
  await page.waitForSelector("text=/cli:help/")
  for (const line of ["accounts:list 4", "contacts:list 5", "erp-settings:show"]) {
    await page.getByTestId("terminal-input").fill(line)
    await page.getByRole("button", { name: "run" }).click()
    await wait(700)
  }
  await shot("7-terminal-comenzi-erp")
} finally {
  await stage.close()
}
console.log("\ndone")
