// The scaffolding every screenshot script needs, and none of them should own.
//
// Split out when `screenshots-erp.mjs` crossed the 6000-char cap: three scripts were each
// carrying their own copy of "start the API, log in, start Next, open a browser, shoot" — around
// 2500 characters of identical setup, drifting apart one fix at a time.
//
// The scripts that remain are the part a person actually reads: which pages to walk and what
// must be on them. The part below is plumbing, and plumbing that is written once is plumbing
// that stays fixed once.
//
//   const stage = await openStage({ slug: "erp", ports: [4540, 4541], wipe: ["erp_accounts"] })
//   await stage.shot("1-catalogue")
//   await stage.close()

import { spawn } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"

const repo = dirname(fileURLToPath(import.meta.url))

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Polls rather than sleeping a fixed amount: a slow machine should wait longer, not fail. */
export const waitFor = async (url, n = 150) => {
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

/**
 * Starts a real API and a real Next dev server, logs in, and hands back a page to walk.
 * Nothing is faked: these screenshots exist so a person can look at the actual screen.
 */
export const openStage = async ({
  slug,
  ports: [apiPort, webPort],
  wipe = [],
  viewport = { width: 1400, height: 950 },
}) => {
  const API = `http://127.0.0.1:${apiPort}`
  const WEB = `http://127.0.0.1:${webPort}`
  const shotsDir = process.env.QWBE_SHOTS_DIR ?? join(repo, `screenshots-${slug}`)
  const dataDir = process.env.QWBE_DATA_DIR ?? join(repo, "data")

  mkdirSync(shotsDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  for (const f of ["auth", "account", ...wipe]) {
    for (const ext of ["sqlite", "sqlite-wal", "sqlite-shm"]) rmSync(join(dataDir, `${f}.${ext}`), { force: true })
  }
  rmSync(join(dataDir, "switches.json"), { force: true })

  const api = spawn(process.execPath, ["src/main.ts"], {
    cwd: join(repo, "core"),
    env: { ...process.env, QWBE_PORT: String(apiPort), QWBE_DATA_DIR: dataDir },
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
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const post = (path, body) =>
    fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json())

  const web = spawn("npx", ["next", "dev", "-p", String(webPort)], {
    cwd: join(repo, "web"),
    env: { ...process.env, NEXT_PUBLIC_QWBE_API: API },
    stdio: "ignore",
  })
  if (!(await waitFor(WEB))) {
    console.error("web did not start")
    api.kill()
    process.exit(1)
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport })

  return {
    API,
    WEB,
    page,
    post,
    headers,
    shot: async (name) => {
      await wait(800)
      await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true })
      console.log(`  ${join(shotsDir, `${name}.png`)}`)
    },
    close: async () => {
      await browser.close()
      web.kill("SIGTERM")
      api.kill("SIGTERM")
    },
  }
}
