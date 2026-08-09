// Screenshots of the custom fields, and a walk through the screens that use them.
//
//   node screenshots-customfields.mjs
//   QWBE_SHOTS_DIR=/somewhere/else node screenshots-customfields.mjs
//
// It does what a person would do: open the customfields screen, add a field to a cube, open a row
// of that cube, fill the field in, save, reload to check it stuck, and then type something the
// definition forbids to see the refusal arrive from the API rather than from the form.
//
// Tests do not catch what is ugly, and a probe cannot tell you whether the panel is in the right
// place on the page. Both processes are started here and stopped at the end.

import { openStage } from "./screenshots-lib.mjs"

// Scaffolding in screenshots-lib.mjs; what stays here is the records this screen needs and the
// pages a person would click through.
const stage = await openStage({
  slug: "customfields",
  ports: [4542, 4543],
  wipe: ["erp_accounts", "erp_contacts", "erp_settings", "accounts", "contacts", "erp-settings", "customfields"],
  viewport: { width: 1400, height: 1000 },
})
const { WEB, page, post, shot } = stage

// Two companies and two people, so the screens have something in them.
const company = await post("/accounts", {
  name: "Public Demo SRL",
  industry: "Technology",
  accountType: "Customer",
  phone: "000 000 001",
  billCity: "Timișoara",
  billCountry: "România",
})
const person = await post("/contacts", {
  salutation: "Dl.",
  firstName: "Ionel",
  lastName: "Popescu",
  jobTitle: "Director tehnic",
  email: "ionel.popescu@example.com",
  accountId: company.id,
  mailingCity: "Timișoara",
})

// One field defined over the API so the "before" screens are not empty; the rest is done by hand
// in the browser below, which is the part worth watching.
await post("/customfields", {
  targetCube: "contacts",
  name: "cnp",
  label: "CNP",
  fieldType: "text",
  required: false,
  position: 1,
})

try {
  await page.goto(WEB, { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "sign in" }).click()
  await page.waitForSelector("text=What is mounted")

  // --- adding a field, by hand, on the screen ---
  await page.locator("nav.bara").locator("[data-cube='customfields']").click()
  await page.waitForSelector("text=Add a field")
  await page.getByTestId("cf-cube").selectOption("contacts")
  await page.getByTestId("cf-name").fill("seniority")
  await page.getByTestId("cf-label").fill("Vechime")
  await page.getByTestId("cf-type").selectOption("select")
  await page.getByTestId("cf-options").fill("junior, mid, senior")
  await shot("1-adaug-camp")
  await page.getByTestId("cf-add").click()
  await page.waitForSelector("[data-field='contacts.seniority']")
  await shot("2-campuri-definite")

  // --- the field shows up on every row of that cube, with no restart ---
  await page.goto(`${WEB}/contacts/${person.id}`, { waitUntil: "networkidle" })
  await page.waitForSelector("text=Custom fields")
  await shot("3-contact-cu-campuri-goale")

  await page.locator("[data-field='cnp']").fill("synthetic-cnp-01")
  await page.locator("select[data-field='seniority']").selectOption("senior")
  await page.getByTestId("save-custom").click()
  await page.waitForSelector("text=saved.")
  await shot("4-completat-si-salvat")

  // --- it stuck: reload and look again ---
  await page.reload({ waitUntil: "networkidle" })
  await page.waitForSelector("text=Custom fields")
  await shot("5-dupa-reincarcare")

  // --- the refusal comes from the cube that owns the definition, not from the form ---
  await page.locator("[data-field='cnp']").fill("x".repeat(1200))
  await page.getByTestId("save-custom").click()
  await page.waitForSelector(".eroare")
  await shot("6-valoare-refuzata-de-api")

  // --- a cube with no custom fields shows no panel at all ---
  await page.goto(`${WEB}/accounts/${company.id}`, { waitUntil: "networkidle" })
  await page.waitForSelector("text=Fields")
  await shot("7-cub-fara-campuri-custom")

  await page.goto(`${WEB}/cli`, { waitUntil: "networkidle" })
  await page.waitForSelector("text=/cli:help/")
  await page.getByTestId("terminal-input").fill("customfields:list contacts")
  await page.getByRole("button", { name: "run" }).click()
  await wait(700)
  await shot("8-terminal")
} finally {
  await stage.close()
}
console.log("\ndone")
