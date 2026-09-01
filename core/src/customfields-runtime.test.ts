// Runtime evidence for QWB-54 ticket 05: the custom-field correctness defects, answered over
// HTTP by TEMPORARY server instances on free ports (the probes' model -- never 4500/4510),
// against one throwaway Postgres database shared by both instances. Postgres on :5433 must be
// up (npm test already requires it for the store tests).
//
// Two instances on ONE database is the point of defect 4: server B boots before any definition
// exists, so the old per-process snapshot would leave it validating on empty forever. The
// target cube is the vault fixture (probes/fixtures/vault-pack), whose roles are skewed so no
// token holds vault:read: that is what makes the new permission gates of defects 3 and 6
// observable (an admin keeps customfields:write, a reader keeps customfields:read, and both
// must still be refused).

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import pg from "pg"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "..")
const core = join(root, "core")
const fixture = join(root, "probes", "fixtures", "vault-pack")
// Since the ownership rules of QWB-54 ticket 08, a boot refuses any declared dataMigration the
// ledger cannot attribute -- including the honest pre-ledger ones the tracked example-plugin
// carries, which a FRESH database has no record of (the operator authorizes those with
// QWBE_LEGACY_MIGRATIONS in production). The test's subject is customfields, not whatever
// else sits in core/plugins on this machine, so the servers here boot against a dedicated
// plugins + store pair holding ONLY the vault fixture: deterministic on any checkout. The
// plugins root lives INSIDE core/ on purpose -- a mounted pack resolves qwbe-core and its
// dependencies exactly the way a checkout sandbox does (stageSandbox nests its sandbox in
// core/ for the same reason).
const pluginsRoot = mkdtempSync(join(core, ".qwbe-ticket05-plugins-"))
const storeRoot = mkdtempSync(join(tmpdir(), "ticket05-store-"))
const installed = join(pluginsRoot, "vault-pack")

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
  })

type Server = { proc: ReturnType<typeof spawn>; port: number; output: string }

const startServer = async (port: number, env: Record<string, string>): Promise<Server> => {
  const proc = spawn(process.execPath, ["src/main.ts"], {
    cwd: core,
    env: { ...process.env, QWBE_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const server: Server = { proc, port, output: "" }
  proc.stdout.on("data", (d) => (server.output += d))
  proc.stderr.on("data", (d) => (server.output += d))
  for (let i = 0; i < 60; i++) {
    await wait(250)
    if (proc.exitCode !== null) throw new Error(`server on :${port} died:\n${server.output}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/openapi.json`)
      // The spec is behind authentication, so 401 counts as listening too.
      if (r.status === 200 || r.status === 401) return server
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`server on :${port} never listened:\n${server.output}`)
}

const call = async (port: number, path: string, options: Record<string, unknown> = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, options)
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* keep the text */
  }
  return { status: r.status, body: body as Record<string, unknown> }
}

const login = async (port: number, username: string, password: string) => {
  const r = await call(port, "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  const token = r.body?.token
  assert.ok(typeof token === "string", `login as ${username} failed: ${JSON.stringify(r.body)}`)
  return { authorization: `Bearer ${token}`, "content-type": "application/json" }
}

const adminUrl = (): string => {
  const u = new URL("postgres://localhost/postgres")
  u.hostname = process.env.QWBE_PG_HOST ?? "localhost"
  u.port = process.env.QWBE_PG_PORT ?? "5433"
  u.username = process.env.QWBE_PG_USER ?? "postgres"
  u.password = process.env.QWBE_PG_PASSWORD ?? "qwbe"
  return u.toString()
}

// One throwaway database for BOTH instances -- the sharing is the defect-4 scenario.
const createDb = async (): Promise<string> => {
  const base = adminUrl()
  const name = `qwbe_ticket05_${Math.random().toString(16).slice(2, 10)}`
  const a = new pg.Pool({ connectionString: base, max: 1 })
  await a.query(`CREATE DATABASE "${name}"`)
  await a.end()
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

const dbUrl = await createDb()
const pool = new pg.Pool({ connectionString: dbUrl })
const dataA = mkdtempSync(join(tmpdir(), "ticket05-a-"))
const dataB = mkdtempSync(join(tmpdir(), "ticket05-b-"))
let serverA: Server
let serverB: Server
let adminHeaders: Record<string, string>
let readerHeaders: Record<string, string>

before(async () => {
  if (existsSync(installed)) throw new Error(`refusing: ${installed} already exists -- remove it first`)
  cpSync(fixture, installed, { recursive: true })
  const [portA, portB] = [await freePort(), await freePort()]
  const env = {
    QWBE_DATABASE_URL: dbUrl,
    QWBE_ADMIN_PASSWORD: "admin",
    QWBE_READER_PASSWORD: "reader",
    QWBE_PLUGINS_DIR: pluginsRoot,
    QWBE_STORE_DIR: storeRoot,
  }
  // Both instances boot BEFORE any definition is created: B must not know the definitions
  // through anything but the shared database.
  ;[serverA, serverB] = await Promise.all([
    startServer(portA, { ...env, QWBE_DATA_DIR: dataA }),
    startServer(portB, { ...env, QWBE_DATA_DIR: dataB }),
  ])
  adminHeaders = await login(portA, "admin", "admin")
  readerHeaders = await login(portB, "reader", "reader")
})

after(async () => {
  for (const s of [serverA, serverB]) s?.proc.kill("SIGTERM")
  await wait(400)
  await pool.query(`DROP DATABASE IF EXISTS "${new URL(dbUrl).pathname.slice(1)}" WITH (FORCE)`).catch(() => {})
  await pool.end()
  rmSync(dataA, { recursive: true, force: true })
  rmSync(dataB, { recursive: true, force: true })
  rmSync(installed, { recursive: true, force: true })
  rmSync(pluginsRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

const define = async (body: Record<string, unknown>) =>
  call(serverA.port, "/customfields", { method: "POST", headers: adminHeaders, body: JSON.stringify(body) })

describe("custom-field correctness over HTTP (QWB-54 ticket 05)", () => {
  let rowId = ""

  it("defect 1: a POST without a required custom field is a 400, with it a 200", async () => {
    const defined = await define({ targetCube: "vault", name: "seal", fieldType: "text", required: true })
    assert.equal(defined.status, 200)
    const without = await call(serverA.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "missing" }),
    })
    assert.equal(without.status, 400)
    assert.match(String(without.body?.message), /seal/)
    const with_ = await call(serverA.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "present", seal: "gold" }),
    })
    assert.equal(with_.status, 200)
    rowId = String(with_.body?.id)
  })

  it("defect 3: orphans refuse customfields:write without vault:read", async () => {
    // Admin holds customfields:write; nobody holds vault:read. Without the new gate this
    // answers 200 and reads another cube's rows.
    const r = await call(serverA.port, "/customfields/orphans?cube=vault", { headers: adminHeaders })
    assert.equal(r.status, 403)
  })

  it("defect 6: setValues refuses customfields:read without vault:read", async () => {
    // The reader passes the old first gate; without the new one it would read the target
    // row's custom values back.
    const r = await call(serverB.port, "/customfields/values", {
      method: "PUT",
      headers: readerHeaders,
      body: JSON.stringify({ cube: "vault", rowId, values: {} }),
    })
    assert.equal(r.status, 403)
  })

  it("defect 2: one-key PATCHes stop at the cap -- the patch that would make 33 keys is a 400", async () => {
    for (let i = 1; i <= 32; i++) {
      const d = await define({ targetCube: "vault", name: `seal${i}`, fieldType: "text" })
      assert.equal(d.status, 200)
    }
    const patched: Array<number> = []
    let refused = { status: 0, body: {} as Record<string, unknown> }
    // The row carries the required `seal` already, so the cap is reached one PATCH earlier
    // than the ticket's from-empty arithmetic: 31 patches land on exactly 32 keys, the 32nd
    // would make 33.
    for (let i = 1; i <= 32; i++) {
      const r = await call(serverA.port, `/vault/${rowId}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ [`seal${i}`]: "x" }),
      })
      patched.push(r.status)
      if (i < 32) assert.equal(r.status, 200, `patch ${i} should have merged fine: ${JSON.stringify(r.body)}`)
      else refused = r
    }
    assert.deepEqual(patched[31], 400)
    assert.match(String(refused.body?.message), /cap/)
  })

  it("defect 4: a definition created through A validates a POST through B", async () => {
    const defined = await define({ targetCube: "vault", name: "age", fieldType: "number" })
    assert.equal(defined.status, 200)
    const invalid = await call(serverB.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "via-b", seal: "s", age: "abc" }),
    })
    assert.equal(invalid.status, 400)
    assert.match(String(invalid.body?.message), /age/)
    const valid = await call(serverB.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "via-b2", seal: "s", age: "41" }),
    })
    assert.equal(valid.status, 200)
  })

  it("defect 4: a definitions read that fails is a 500, never validate-on-empty", async () => {
    await pool.query(`REVOKE USAGE ON SCHEMA "customfields" FROM qwbe_cube_customfields`)
    const broken = await call(serverA.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "broken", seal: "s" }),
    })
    assert.equal(broken.status, 500)
    await pool.query(`GRANT USAGE ON SCHEMA "customfields" TO qwbe_cube_customfields`)
    const recovered = await call(serverA.port, "/vault", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "recovered", seal: "s" }),
    })
    assert.equal(recovered.status, 200)
  })
})
