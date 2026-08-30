// Shared bits for the probes: start the server, wait for it, keep score.
//
// Each probe starts the server itself rather than assuming one is running. A server started by
// an agent lives inside that agent's sandbox — `ss` reports LISTEN while a request from
// elsewhere gets ECONNREFUSED. Starting and querying in the same process puts the evidence in
// the same place as the act.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
export const root = join(here, "..")
export const coreDir = join(root, "core")

export const wait = (ms) => new Promise((r) => setTimeout(r, ms))

export const makeScore = () => {
  const lines = []
  let passed = 0
  let failed = 0
  return {
    check(name, ok, detail = "") {
      if (ok) {
        passed++
        lines.push(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`)
      } else {
        failed++
        lines.push(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
      }
    },
    report(title) {
      console.log(`\n${title} — ${passed} pass, ${failed} fail\n`)
      console.log(lines.join("\n"))
      console.log("")
      return failed === 0 ? 0 : 1
    },
  }
}

/**
 * A databases directory that belongs to THIS run and nobody else.
 *
 * What was here before: `<root>/data`, wiped between runs by deleting a hardcoded list of
 * filenames. Two things were wrong with it, and both were quiet.
 *
 * The list only named the cubes that existed when it was written, so `tasks`, `contacts`,
 * `contracts`, `reports` and `customfields` all survived the wipe and carried their rows into
 * the next run. Counts drifted, and a probe could fail on yesterday's data.
 *
 * `<root>/data` is also the directory the owner's own server uses. A probe that fails because
 * someone has the application open teaches people to ignore red, which costs more than the
 * probe was ever worth.
 *
 * A fresh empty directory fixes both without a list to keep up to date: nothing to forget,
 * nothing to inherit, nobody else's data to break.
 */
export const scratchDataDir = (label = "qwbe") => mkdtempSync(join(tmpdir(), `${label}-data-`))

/** Throw away a scratch directory. Safe to call twice, and never touches `<root>/data`. */
export const dropScratch = (dir) => {
  if (dir?.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
}

/**
 * A port the operating system says is free right now.
 *
 * Three probes shipped with the same hardcoded 4507, so running two at once produced
 * EADDRINUSE — read as "the code broke" by whoever saw it next. Asking for port 0 and reading
 * back what was granted leaves a small race between close and re-listen; that is a far smaller
 * window than two probes permanently claiming the same number.
 */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

export const startServer = async (port, env = {}) => {
  const proc = spawn(process.execPath, ["src/main.ts"], {
    cwd: coreDir,
    env: {
      ...process.env,
      QWBE_PORT: String(port),
      QWBE_ADMIN_PASSWORD: "admin",
      QWBE_READER_PASSWORD: "reader",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  proc.stdout.on("data", (d) => (output += d))
  proc.stderr.on("data", (d) => (output += d))

  for (let i = 0; i < 60; i++) {
    await wait(250)
    if (proc.exitCode !== null)
      return {
        proc,
        alive: false,
        get output() {
          return output
        },
      }
    try {
      // The spec is behind authentication (QWB-41), so 401 counts as "listening" too.
      const r = await fetch(`http://127.0.0.1:${port}/openapi.json`)
      if (r.status === 200 || r.status === 401) {
        return {
          proc,
          alive: true,
          get output() {
            return output
          },
        }
      }
    } catch {
      /* not listening yet */
    }
  }
  return {
    proc,
    alive: false,
    get output() {
      return output
    },
  }
}

export const stopServer = async (s) => {
  s.proc.kill("SIGTERM")
  await wait(400)
}

/** Tiny JSON client. Returns status and parsed body, never throws on a non-2xx. */
export const client = (port) => {
  const base = `http://127.0.0.1:${port}`
  const call = async (path, options = {}) => {
    const r = await fetch(base + path, options)
    const text = await r.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: r.status, body }
  }
  return {
    call,
    async login(username = "admin", password = "admin") {
      const r = await call("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const token = r.body?.token
      return {
        status: r.status,
        token,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      }
    },
  }
}
