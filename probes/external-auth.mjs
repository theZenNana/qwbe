// Auth for external origins: the token lifecycle over HTTP, and the CORS
// allowlist read from QWBE_ALLOWED_ORIGINS.
//
//   node probes/external-auth.mjs
//
// Two servers are started, each in its own scratch data directory on its own free port:
// one with the allowlist set, one with the variable unset (the default, which
// must keep working). CORS is checked by sending an Origin header like a browser would
// and reading back `access-control-allow-origin` -- the header the browser enforces on.

import { client, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

const score = makeScore()

// Raw fetch, because the CORS verdict lives in the response headers, which `client` drops.
const preflightOn = (port) => async (origin) =>
  fetch(`http://127.0.0.1:${port}/notes`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "GET" },
  }).then((r) => r.headers.get("access-control-allow-origin"))

// --- part 1: login / me / logout / 401, on a server with no origin configuration ---

const PORT1 = await freePort()
const dataDir1 = scratchDataDir("extauth-default")
const api1 = client(PORT1)
const server1 = await startServer(PORT1, { QWBE_DATA_DIR: dataDir1, QWBE_ALLOWED_ORIGINS: undefined })
if (!server1.alive) {
  console.error(`server did not start:\n${server1.output}`)
  process.exit(1)
}

try {
  const loginRaw = await api1.call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  })
  score.check(
    "login -> token and expiresAt",
    loginRaw.status === 200 && !!loginRaw.body?.token && !!loginRaw.body?.expiresAt,
    `http=${loginRaw.status}`,
  )

  const session = await api1.login()
  score.check("login helper -> token", session.status === 200 && !!session.token, `http=${session.status}`)

  const me = await api1.call("/auth/me", { headers: session.headers })
  score.check(
    "authenticated /auth/me -> 200",
    me.status === 200 && me.body?.username === "admin",
    `http=${me.status} user=${me.body?.username}`,
  )

  const out = await api1.call("/auth/logout", { method: "POST", headers: session.headers })
  score.check("logout -> 200", out.status === 200, `http=${out.status}`)

  const after = await api1.call("/auth/me", { headers: session.headers })
  score.check("the same token after logout -> 401", after.status === 401, `http=${after.status}`)

  const noToken = await api1.call("/auth/me")
  score.check("no token at all -> 401", noToken.status === 401, `http=${noToken.status}`)

  // With the variable unset the allowlist is ["*"]: any Origin must get the literal `*`
  // header.
  const wildcard = await preflightOn(PORT1)("http://evil.example")
  score.check("unset variable, any origin -> allow header is *", wildcard === "*", `header=${wildcard}`)
} finally {
  await stopServer(server1)
  dropScratch(dataDir1)
}

// --- part 2: the CORS allowlist ---

const PORT2 = await freePort()
const dataDir2 = scratchDataDir("extauth-cors")
const api2 = client(PORT2)
const ALLOWED = "http://localhost:3000,https://crm.example.test"
const server2 = await startServer(PORT2, { QWBE_DATA_DIR: dataDir2, QWBE_ALLOWED_ORIGINS: ALLOWED })
if (!server2.alive) {
  console.error(`server did not start:\n${server2.output}`)
  process.exit(1)
}

const preflight = preflightOn(PORT2)

const actual = async (origin) =>
  fetch(`http://127.0.0.1:${PORT2}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  }).then((r) => r.headers.get("access-control-allow-origin"))

try {
  const listed = await preflight("http://localhost:3000")
  score.check(
    "preflight from a listed origin -> allow header echoes it",
    listed === "http://localhost:3000",
    `header=${listed}`,
  )

  const second = await preflight("https://crm.example.test")
  score.check(
    "preflight from a second listed origin -> allowed",
    second === "https://crm.example.test",
    `header=${second}`,
  )

  const stranger = await preflight("http://evil.example")
  score.check("preflight from an unlisted origin -> no allow header", stranger === null, `header=${stranger}`)

  const actualListed = await actual("http://localhost:3000")
  score.check(
    "actual request from a listed origin -> allow header",
    actualListed === "http://localhost:3000",
    `header=${actualListed}`,
  )

  const actualStranger = await actual("http://evil.example")
  score.check(
    "actual request from an unlisted origin -> no allow header",
    actualStranger === null,
    `header=${actualStranger}`,
  )

  // A non-browser client sends no Origin at all; CORS must not get in its way.
  const noOrigin = await api2.call("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  })
  score.check(
    "request without an Origin (non-browser) -> login still works",
    noOrigin.status === 200,
    `http=${noOrigin.status}`,
  )
} finally {
  await stopServer(server2)
  dropScratch(dataDir2)
}

// --- part 2b: a SINGLE-entry allowlist must still check every request ---
// Effect's cors middleware only compares the Origin when the array has more than one entry;
// the server passes a predicate instead, so one entry must behave like many.

const PORT5 = await freePort()
const dataDir5 = scratchDataDir("extauth-single")
const server5 = await startServer(PORT5, { QWBE_DATA_DIR: dataDir5, QWBE_ALLOWED_ORIGINS: "http://localhost:3000" })
if (!server5.alive) {
  console.error(`server did not start:\n${server5.output}`)
  process.exit(1)
}
try {
  const listed = await preflightOn(PORT5)("http://localhost:3000")
  score.check(
    "single-entry list, listed origin -> allow header echoes it",
    listed === "http://localhost:3000",
    `header=${listed}`,
  )
  const stranger = await preflightOn(PORT5)("http://evil.example")
  score.check("single-entry list, unlisted origin -> no allow header", stranger === null, `header=${stranger}`)
} finally {
  await stopServer(server5)
  dropScratch(dataDir5)
}

// --- part 3: malformed QWBE_ALLOWED_ORIGINS stops the startup ---
//
// Spawn drops undefined env values, so `undefined` in part 1 really exercises the unset case;
// these cases exercise the malformed ones. A SET-but-empty variable is malformed, not unset:
// it must refuse to start rather than silently widen back to *.

for (const [value, message] of [
  ["http://ok.test,,http://x.test", "empty origin"],
  ["localhost:3000", "not a bare origin"],
  ["", "refuses to start on an empty value"],
]) {
  const port = await freePort()
  const dataDir = scratchDataDir(`extauth-bad-${message.slice(0, 8)}`)
  const server = await startServer(port, { QWBE_DATA_DIR: dataDir, QWBE_ALLOWED_ORIGINS: value })
  score.check(
    `malformed QWBE_ALLOWED_ORIGINS (${JSON.stringify(value)}) -> refuses to start`,
    !server.alive && (message === "refuses to start on an empty value" || server.output.includes(message)),
    `alive=${server.alive}`,
  )
  await stopServer(server)
  dropScratch(dataDir)
}

process.exit(score.report("external-auth"))
