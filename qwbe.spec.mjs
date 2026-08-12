// Playwright tests for the cubes prototype.
//
//   npx playwright test
//
// The test starts both processes itself — the Effect API and the sibling Next app — on their
// own ports, and stops them at the end. A server started by an agent lives in that agent's
// sandbox: `ss` says LISTEN while a request from elsewhere gets ECONNREFUSED, so the evidence
// has to be produced where the act happens.
//
// Parallel mode does not suit this suite: each test would land in its own worker, each would run
// `beforeAll`, start another API on the same port and wipe the databases underneath whichever
// test was running. Serial, therefore — one worker, one startup, stable data.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

test.describe.configure({ mode: "serial" })

const here = dirname(fileURLToPath(import.meta.url))
const PORT_API = 4520
const PORT_WEB = 4521
const API = `http://127.0.0.1:${PORT_API}`
const WEB = `http://127.0.0.1:${PORT_WEB}`

let apiProc
let webProc
let bookmarkId
let tagId
let dataDir

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const waitForResponse = async (url, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    await wait(500)
    try {
      if ((await fetch(url)).status < 500) return true
    } catch {
      /* not listening yet */
    }
  }
  return false
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  dataDir = mkdtempSync(join(tmpdir(), "qwbe-e2e-"))

  apiProc = spawn(process.execPath, ["src/main.ts"], {
    cwd: join(here, "core"),
    env: {
      ...process.env,
      QWBE_PORT: String(PORT_API),
      QWBE_DATA_DIR: dataDir,
      QWBE_ADMIN_PASSWORD: "admin",
      QWBE_READER_PASSWORD: "reader",
    },
    stdio: "ignore",
  })
  expect(await waitForResponse(`${API}/openapi.json`), "the API did not start").toBe(true)

  // Seed through the API, on the same routes a person would use.
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

  // 12 notes: enough for paging to matter at a UI limit of 10 and a group limit of 5.
  for (let i = 1; i <= 12; i++) {
    await fetch(`${API}/notes`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: `Note ${String(i).padStart(2, "0")}`, body: `body ${i}` }),
    })
  }
  const bookmarkResponse = await fetch(`${API}/bookmarks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "Notes shortcut", targetCube: "notes" }),
  })
  expect(bookmarkResponse.status, "bookmark fixture was not created").toBe(200)
  bookmarkId = (await bookmarkResponse.json()).id

  const tagResponse = await fetch(`${API}/tags`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "important", bookmarkId }),
  })
  expect(tagResponse.status, "tag fixture was not created").toBe(200)
  tagId = (await tagResponse.json()).id

  webProc = spawn("npx", ["next", "start", "-p", String(PORT_WEB)], {
    cwd: join(here, "web"),
    env: { ...process.env, NEXT_PUBLIC_QWBE_API: API },
    stdio: "ignore",
  })
  expect(await waitForResponse(WEB), "the web app did not start").toBe(true)
})

test.afterAll(() => {
  webProc?.kill("SIGTERM")
  apiProc?.kill("SIGTERM")
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

const signIn = async (page) => {
  await page.goto(WEB, { waitUntil: "networkidle" })
  if (
    await page
      .getByRole("button", { name: "sign in" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByPlaceholder("username").fill("admin")
    await page.getByPlaceholder("password").fill("admin")
    await page.getByRole("button", { name: "sign in" }).click()
  }
  await expect(page.getByRole("heading", { name: "What is mounted" })).toBeVisible({ timeout: 30_000 })
}

test("the sidebar is drawn from the catalogue, including a cube that came from a plugin", async ({ page }) => {
  await signIn(page)

  const sidebar = page.locator("nav.bara")
  await expect(sidebar.locator("[data-cube='notes']")).toBeVisible()
  await expect(sidebar.locator("[data-cube='account']")).toBeVisible()
  // The one that arrived in a plugin sits in the same list as the rest, marked as such.
  await expect(sidebar.locator("[data-cube='booktags/bookmarks']")).toBeVisible()
  await expect(sidebar.locator("a", { has: page.locator("[data-cube='booktags/bookmarks']") })).toContainText("plugin")

  // The table says where each cube came from — core or a named plugin.
  const bookmarkRow = page.locator("tbody tr", { hasText: "booktags/bookmarks" }).first()
  await expect(bookmarkRow).toContainText("plugin: example-plugin")

  // The link shown on the notes row was declared by a space, not by the notes cube.
  const notesRow = page.locator("tbody tr", { hasText: "notes" }).first()
  await expect(notesRow).toContainText("authorId → Account")
})

test("the shell always exposes API docs and reports API availability honestly", async ({ page, request }) => {
  await signIn(page)

  const apiLinks = page.getByRole("navigation", { name: "API documentation" })
  await expect(apiLinks.getByRole("link", { name: "API Docs" })).toHaveAttribute("href", `${API}/docs`)
  await expect(apiLinks.getByRole("link", { name: "API Docs" })).toHaveAttribute("target", "_blank")
  await expect(apiLinks.getByRole("link", { name: "API Docs" })).toHaveAttribute("rel", "noreferrer")
  await expect(apiLinks.getByRole("link", { name: "OpenAPI" })).toHaveAttribute("href", `${API}/openapi.json`)
  await expect(apiLinks.getByRole("link", { name: "OpenAPI" })).toHaveAttribute("target", "_blank")
  await expect(apiLinks.getByRole("link", { name: "OpenAPI" })).toHaveAttribute("rel", "noreferrer")
  await expect(apiLinks.getByText("API connected")).toBeVisible()
  expect((await request.get(`${API}/docs`)).status()).toBe(200)
  expect((await request.get(`${API}/openapi.json`)).status()).toBe(200)

  await page.locator("nav.bara").getByText("notes", { exact: true }).click()
  await expect(apiLinks.getByRole("link", { name: "API Docs" })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  for (const element of [apiLinks, page.locator("nav.bara"), page.getByRole("button", { name: "sign out" })]) {
    expect(
      await element.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth
      }),
    ).toBe(true)
  }

  await page.route(`${API}/settings/cubes`, (route) => route.abort())
  await page.goto(`${WEB}/settings`, { waitUntil: "networkidle" })
  await expect(apiLinks.getByText("API unavailable")).toBeVisible()
  await expect(apiLinks.getByRole("link")).toHaveCount(0)

  await page.unroute(`${API}/settings/cubes`)
  await page.goto(`${WEB}/notes`, { waitUntil: "networkidle" })
  await expect(apiLinks.getByText("API connected")).toBeVisible()
  await expect(apiLinks.getByRole("link", { name: "API Docs" })).toBeVisible()
})

test("lists are paged: 10 per page, with the real total", async ({ page }) => {
  await signIn(page)
  await page.locator("nav.bara").getByText("notes", { exact: true }).click()

  await expect(page.getByRole("heading", { name: "notes" })).toBeVisible()
  await expect(page.getByText(/1-10 of 12/)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator("tbody tr")).toHaveCount(10)

  await page.getByRole("button", { name: "next ->" }).click()
  await expect(page.getByText(/11-12 of 12/)).toBeVisible()
  await expect(page.locator("tbody tr")).toHaveCount(2)
})

test("Booktags settings uses the generic paged list without crashing", async ({ page }) => {
  const pageErrors = []
  page.on("pageerror", (error) => pageErrors.push(error.message))

  await signIn(page)
  await page.goto(`${WEB}/booktags/settings`, { waitUntil: "networkidle" })

  await expect(page.getByRole("heading", { name: "booktags/settings" })).toBeVisible()
  await expect(page.getByText("Nothing here yet.")).toBeVisible()
  expect(pageErrors).toEqual([])
})

test("a bookmark detail shows its target cube and related tag", async ({ page }) => {
  await signIn(page)
  await page.goto(`${WEB}/booktags/bookmarks/${bookmarkId}`, { waitUntil: "networkidle" })

  await expect(page.getByRole("heading", { name: "Notes shortcut" })).toBeVisible()
  await expect(page.getByRole("link", { name: "notes", exact: true })).toHaveAttribute("href", "/notes")
  await expect(page.getByRole("button", { name: "tags (1)" })).toBeVisible()
  const tagLink = page.getByRole("link", { name: "important" })
  await expect(tagLink).toHaveAttribute("href", `/booktags/tags/${tagId}`)

  await tagLink.click()
  await expect(page.getByRole("heading", { name: "important" })).toBeVisible()
})

test("an account's page shows the space-declared group, with a total, and pages it", async ({ page }) => {
  await signIn(page)
  await page.locator("nav.bara").getByText("account", { exact: true }).click()
  await page.locator("tbody tr", { hasText: "admin" }).getByRole("link").first().click()

  await expect(page.getByRole("heading", { name: "admin" })).toBeVisible({ timeout: 20_000 })

  // The group head carries the real total (12) although the page only asked for 5 rows.
  await expect(page.getByRole("button", { name: /notes \(12\)/ })).toBeVisible()
  await expect(page.getByText(/1-5 of 12/)).toBeVisible()
  await page.getByRole("button", { name: "next ->" }).last().click()
  await expect(page.getByText(/6-10 of 12/)).toBeVisible()
})

test("the terminal runs a declared command and refuses an undeclared one", async ({ page }) => {
  await signIn(page)
  await page.getByRole("link", { name: "terminal" }).click()
  await expect(page.getByRole("heading", { name: "terminal" })).toBeVisible()

  // The command list comes from the cubes' manifests, plugin included.
  await expect(page.getByRole("button", { name: "notes:count" })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("button", { name: "booktags/bookmarks:count" })).toBeVisible()

  const input = page.getByTestId("terminal-input")
  const output = page.getByTestId("terminal-output")

  await input.fill("notes:count")
  await page.getByRole("button", { name: "run" }).click()
  await expect(output).toContainText("$ notes:count")
  await expect(output).toContainText("12")

  await input.fill("notes:recent 3")
  await page.getByRole("button", { name: "run" }).click()
  await expect(output).toContainText("Note 12")

  // No shell behind the gate: an undeclared name is refused and the known ones are listed.
  await input.fill("rm -rf /")
  await page.getByRole("button", { name: "run" }).click()
  await expect(output).toContainText("unknown command")
})

test("switching a cube off removes its tab, its group elsewhere, and its commands", async ({ page }) => {
  await signIn(page)

  await page.getByRole("link", { name: "settings", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()

  const notesRow = page.locator("tbody tr", { hasText: "notes" }).first()
  await notesRow.getByRole("button", { name: "switch off" }).click()
  await expect(notesRow.getByText("off")).toBeVisible({ timeout: 15_000 })

  // A required cube has no button to press — the rule is visible, not just enforced.
  const settingsRow = page.locator("tbody tr", { hasText: "settings" }).first()
  await expect(settingsRow.getByRole("button", { name: "required" })).toBeDisabled()

  // The effect on ANOTHER cube: the group declared by the space disappears.
  await page.locator("nav.bara").getByText("account", { exact: true }).click()
  await page.locator("tbody tr", { hasText: "admin" }).getByRole("link").first().click()
  await expect(page.getByRole("heading", { name: "admin" })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole("button", { name: /notes \(/ })).toHaveCount(0)

  // And its commands leave the terminal.
  await page.getByRole("link", { name: "terminal" }).click()
  await expect(page.getByRole("button", { name: "notes:count" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "booktags/bookmarks:count" })).toBeVisible()

  // Switch back on so the tests are order-independent.
  await page.getByRole("link", { name: "settings", exact: true }).click()
  await page.locator("tbody tr", { hasText: "notes" }).first().getByRole("button", { name: "switch on" }).click()
  await expect(page.locator("tbody tr", { hasText: "notes" }).first().getByText("on")).toBeVisible({
    timeout: 15_000,
  })
})
