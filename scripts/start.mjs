// One start step for the whole project.
//
//   npm start
//
// Runs the API and the frontend side by side, prefixes every line so it is clear who is
// speaking, and takes both down on Ctrl-C. No dependency of its own — no `concurrently`, no
// `npm-run-all`. `node:child_process` does all of it, and the project keeps its zero-dependency
// claim outside Effect and Next.
//
//   QWBE_PORT=4530 npm start     moves the API; the frontend is told where it went
//   the web port lives in web/package.json ("dev": "next dev -p 4510") and is read from there

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// --- ports -----------------------------------------------------------------------------------
//
// One source of truth each: the API reads QWBE_PORT itself (core/src/main.ts), and the web port
// is an argument inside web/package.json. Parsing it beats writing it down twice.

const API_PORT = Number(process.env.QWBE_PORT ?? 4500)

const readWebPort = () => {
  const pkg = JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8"))
  const dev = pkg.scripts?.dev ?? ""
  const m = dev.match(/(?:-p|--port)[= ](\d+)/)
  if (!m) {
    console.error(
      `\nCould not find a port in web/package.json → scripts.dev ("${dev}").\n` +
        `  Expected something like "next dev -p 4510".\n`,
    )
    process.exit(1)
  }
  return Number(m[1])
}

const WEB_PORT = readWebPort()

// --- is the port free? -----------------------------------------------------------------------
//
// EADDRINUSE from deep inside Next is a wall of stack. Asking first turns it into one line that
// says which port and what to do.

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.once("listening", () => probe.close(() => resolve(true)))
    probe.listen(port, "127.0.0.1")
  })

for (const [name, port, hint] of [
  ["API", API_PORT, "QWBE_PORT=4530 npm start"],
  ["web", WEB_PORT, 'change "next dev -p …" in web/package.json'],
]) {
  if (!(await portFree(port))) {
    console.error(
      `\nPort ${port} (${name}) is already taken — nothing was started.\n\n` +
        `  See who has it:  ss -ltnp | grep ${port}\n` +
        `  Or move it:      ${hint}\n`,
    )
    process.exit(1)
  }
}

// --- children --------------------------------------------------------------------------------

const npm = process.platform === "win32" ? "npm.cmd" : "npm"

const COLOR = process.stdout.isTTY
const paint = (code, s) => (COLOR ? `[${code}m${s}[0m` : s)

const children = []
let shuttingDown = false

const start = ({ name, color, command, args, cwd, env }) => {
  const tag = paint(color, `[${name}]`)
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group. `npm run dev` spawns Next as a grandchild; killing npm alone
    // leaves Next holding the port. With a group we signal the whole tree at once, which is
    // the difference between "Ctrl-C worked" and an orphan on :4510.
    detached: true,
  })

  // Line-buffered so a chunk split mid-line does not lose the prefix.
  const pipe = (stream) => {
    let rest = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) console.log(`${tag} ${line}`)
    })
    stream.on("end", () => {
      if (rest.length > 0) console.log(`${tag} ${rest}`)
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)

  child.on("error", (e) => {
    console.error(`${tag} could not start: ${e.message}`)
    shutdown(1)
  })

  child.on("exit", (code, signal) => {
    child.dead = true
    if (shuttingDown) return
    console.log(`${tag} exited (${signal ? `signal ${signal}` : `code ${code}`}) — stopping the rest`)
    shutdown(code ?? 1)
  })

  children.push(child)
  return child
}

// --- clean stop ------------------------------------------------------------------------------

const killGroup = (child, signal) => {
  if (child.dead || child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

const shutdown = (code) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\nstopping…")
  for (const child of children) killGroup(child, "SIGTERM")

  // Anything still alive after the grace period is not going to leave politely.
  const grace = setTimeout(() => {
    for (const child of children) killGroup(child, "SIGKILL")
    process.exit(code)
  }, 5000)
  grace.unref()

  const waitForDead = setInterval(() => {
    if (children.every((c) => c.dead)) {
      clearInterval(waitForDead)
      clearTimeout(grace)
      process.exit(code)
    }
  }, 100)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown(0))
// Last resort: if this process ends any other way, the children still go with it.
process.on("exit", () => {
  for (const child of children) killGroup(child, "SIGKILL")
})

// --- go --------------------------------------------------------------------------------------

console.log(
  `Qwbe — API on http://127.0.0.1:${API_PORT} (docs at /docs), web on http://127.0.0.1:${WEB_PORT}\n` +
    `Sign in as admin / admin. Ctrl-C stops both.\n`,
)

start({
  name: "api",
  color: 36, // cyan
  command: process.execPath,
  args: ["src/main.ts"],
  cwd: join(root, "core"),
  env: { QWBE_PORT: String(API_PORT) },
})

start({
  name: "web",
  color: 35, // magenta
  command: npm,
  args: ["run", "dev"],
  cwd: join(root, "web"),
  // The frontend only knows the API by its address; if QWBE_PORT moved it, say so here rather
  // than making the reader discover a silently broken login.
  env: {
    NEXT_PUBLIC_QWBE_API: process.env.NEXT_PUBLIC_QWBE_API ?? `http://127.0.0.1:${API_PORT}`,
  },
})
