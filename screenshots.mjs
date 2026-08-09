// Screenshots, so a person can look at this with their eyes. Tests do not catch what is ugly.
//
//   node screenshots.mjs   -> writes into `screenshots/`
//
// Starts both processes itself, like the tests, and stops them at the end.

import { spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const PORT_API = 4530
const PORT_WEB = 4531
const API = `http://127.0.0.1:${PORT_API}`
const WEB = `http://127.0.0.1:${PORT_WEB}`
const shotsDir = join(here, "screenshots")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (url, n = 150) => {
  for (let i = 0; i < n; i++) {
    await wait(500)
    try {
      if ((await fetch(url)).status < 500) return true
    } catch {
      /* not yet */
    }
  }
  return false
}

for (const f of ["auth", "account", "notes", "bookmarks"]) {
  for (const ext of ["sqlite", "sqlite-wal", "sqlite-shm"]) {
    rmSync(join(here, "data", `${f}.${ext}`), { force: true })
  }
}
rmSync(join(here, "data", "switches.json"), { force: true })
mkdirSync(shotsDir, { recursive: true })

const api = spawn(process.execPath, ["src/main.ts"], {
  cwd: join(here, "core"),
  env: { ...process.env, QWBE_PORT: String(PORT_API) },
  stdio: "ignore",
})
if (!(await waitFor(`${API}/openapi.json`))) {
  console.error("API did not start")
  process.exit(1)
}

const token = (
  await (
    await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    })
  ).json()
).token
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" }

const titles = [
  "Kernel discovers cubes from disk",
  "Spaces declare the links",
  "One SQLite file per cube",
  "The CLI gate",
  "Plugins land in level 0",
  "Pagination lives in the contract",
  "Opaque tokens, not JWT",
  "One cube, one directory",
  "Switched off means not there",
  "A dangling link warns, never fatal",
  "The registry is the only data path",
  "The bus is the only event path",
]
for (let i = 0; i < titles.length; i++) {
  await fetch(`${API}/notes`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ title: titles[i], body: `Written while building the prototype (${i + 1}/12).` }),
  })
}
for (const [label, url] of [
  ["Effect docs", "https://effect.website"],
  ["Module boundary notes", "https://example.com/module-boundaries"],
]) {
  await fetch(`${API}/bookmarks`, { method: "POST", headers: H, body: JSON.stringify({ label, url }) })
}

const web = spawn("npx", ["next", "dev", "-p", String(PORT_WEB)], {
  cwd: join(here, "web"),
  env: { ...process.env, NEXT_PUBLIC_QWBE_API: API },
  stdio: "ignore",
})
if (!(await waitFor(WEB))) {
  console.error("web did not start")
  api.kill()
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const shot = async (name) => {
  await wait(700)
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true })
  console.log(`  screenshots/${name}.png`)
}

try {
  await page.goto(WEB, { waitUntil: "networkidle" })
  await shot("1-sign-in")

  await page.getByRole("button", { name: "sign in" }).click()
  await page.waitForSelector("text=What is mounted")
  await shot("2-catalogue")

  await page.locator("nav.bara").locator("[data-cube='notes']").click()
  await page.waitForSelector("text=/of 12/")
  await shot("3-paged-list")

  await page.locator("nav.bara").locator("[data-cube='account']").click()
  await page.waitForSelector("text=admin")
  await page.locator("tbody tr", { hasText: "admin" }).getByRole("link").first().click()
  await page.waitForSelector("text=/notes \\(12\\)/")
  await shot("4-detail-with-space-link")

  await page.getByRole("link", { name: "terminal" }).click()
  await page.waitForSelector("text=/cli:help/")
  await page.getByTestId("terminal-input").fill("cli:help")
  await page.getByRole("button", { name: "run" }).click()
  await wait(600)
  await page.getByTestId("terminal-input").fill("notes:recent 3")
  await page.getByRole("button", { name: "run" }).click()
  await wait(600)
  // Shown on purpose: the gate refuses anything that is not a declared command.
  await page.getByTestId("terminal-input").fill("rm -rf /")
  await page.getByRole("button", { name: "run" }).click()
  await page.waitForSelector("text=/unknown command/")
  await shot("5-terminal")

  await page.getByRole("link", { name: "settings", exact: true }).click()
  await page.waitForSelector("text=Settings")
  await shot("6-settings")

  await page.locator("tbody tr", { hasText: "notes" }).first().getByRole("button", { name: "switch off" }).click()
  await wait(1000)
  await shot("7-notes-switched-off")

  await page.locator("nav.bara").locator("[data-cube='account']").click()
  await page.locator("tbody tr", { hasText: "admin" }).getByRole("link").first().click()
  await wait(1200)
  await shot("8-group-gone-after-switch-off")

  await page.getByRole("link", { name: "settings", exact: true }).click()
  await page.locator("tbody tr", { hasText: "notes" }).first().getByRole("button", { name: "switch on" }).click()
  await wait(700)

  await page.locator("nav.bara").locator("[data-cube='bookmarks']").click()
  await page.waitForSelector("text=Effect docs")
  await shot("9-plugin-cube-list")
} finally {
  await browser.close()
  web.kill("SIGTERM")
  api.kill("SIGTERM")
}
console.log("\ndone")
