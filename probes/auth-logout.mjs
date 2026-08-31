// Probe: logout closes ONLY the session that asked for it (QWB-54, ticket 21).
//
// Two logins of the same account; logout on the first session; the second session must keep
// answering. Before the fix, logout dropped every session of the account, so the last check
// below got 401 and the second device was logged out against its will.
//
//   node probes/auth-logout.mjs

import { client, freePort, makeScore, startServer, stopServer } from "./lib.mjs"

const PORT = await freePort()
const score = makeScore()
const api = client(PORT)

const server = await startServer(PORT)
if (!server.alive) {
  console.error(`server did not start:\n${server.output}`)
  process.exit(1)
}

try {
  // Two independent logins of the SAME account: two sessions, two opaque tokens.
  const first = await api.login()
  const second = await api.login()
  score.check(
    "two logins of one account -> two different tokens",
    first.status === 200 && second.status === 200 && !!first.token && !!second.token && first.token !== second.token,
    `http=${first.status}/${second.status}`,
  )

  const me2 = await api.call("/auth/me", { headers: second.headers })
  score.check("second session alive before any logout", me2.status === 200, `http=${me2.status}`)

  const out = await api.call("/auth/logout", { method: "POST", headers: first.headers })
  score.check("logout on the first session -> 200", out.status === 200, `http=${out.status}`)

  const afterFirst = await api.call("/auth/me", { headers: first.headers })
  score.check("the session that logged out is closed", afterFirst.status === 401, `http=${afterFirst.status}`)

  // The check the old behaviour failed: the OTHER session of the same account survives.
  const afterSecond = await api.call("/auth/me", { headers: second.headers })
  score.check(
    "the other session still answers 200 after the first logged out",
    afterSecond.status === 200,
    `http=${afterSecond.status}`,
  )
} finally {
  await stopServer(server)
}

process.exit(score.report("Auth logout-scope probe"))
