// The second half of the invariant probe: what happens when a REAL cube leaves the disk.
//
// Sections 1–3 of `decoupling.mjs` add things — a cube, a plugin — and measure that nothing
// existing was touched. This file is the other direction, and it is the harder claim: delete
// `cubes/notes/` outright and the system must keep running, with the link the space declared
// degrading into a warning rather than a crash.
//
// It lives in its own file because `decoupling.mjs` grew past its size cap, and this was the
// seam already drawn in the original: everything here is about one cube being absent, and
// nothing above needs it.
//
// The paths are exported rather than passed in, because the CALLER's `finally` has to put
// `notes` back if this half dies halfway. Owning the two paths in one place is what makes that
// restoration mean the same thing on both sides.

import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { coreDir, root, startServer, stopServer } from "./lib.mjs"

const cubesDir = join(coreDir, "src", "cubes")

export const notesDir = join(cubesDir, "notes")
export const notesBackup = join(root, ".notes-moved-temporarily")

export const cubeRemovedFromDisk = async ({ api, score, port, dataDir }) => {
  // ============ 4. a real cube removed from disk ============
  cpSync(notesDir, notesBackup, { recursive: true })
  rmSync(notesDir, { recursive: true, force: true })

  // The caller's own databases directory: all boots of this probe must read the same one.
  const s3 = await startServer(port, { QWBE_DATA_DIR: dataDir })
  score.check(
    "server starts with the `notes` cube DELETED from disk",
    s3.alive,
    s3.alive ? "" : s3.output.slice(0, 500),
  )

  // The space still declares a link to the cube that is gone. That must be a loud warning, not
  // a fatal error — otherwise removing a cube would require editing a file that is not yours,
  // which is the invariant broken from the other direction.
  score.check(
    "the now-dangling link is reported as a warning, and the system runs anyway",
    s3.alive && s3.output.includes("point nowhere"),
    s3.alive ? "warning printed at startup" : "server did not start",
  )

  if (s3.alive) {
    const session = await api.login()
    const H = session.headers

    const account = await api.call("/account?limit=1", { headers: H })
    score.check("the account cube carries on untouched", account.status === 200, `http=${account.status}`)

    const notes = await api.call("/notes?limit=1", { headers: H })
    score.check("its routes no longer exist", notes.status === 404, `http=${notes.status}`)

    const me = await api.call("/auth/me", { headers: H })
    score.check(
      "its permissions dropped out of auth by themselves",
      !me.body?.permissions?.some((p) => p.startsWith("notes:")),
      `left: ${me.body?.permissions?.join(", ")}`,
    )

    const commands = await api.call("/cli/commands", { headers: H })
    score.check(
      "its commands dropped out of the CLI by themselves",
      !(commands.body ?? []).some((c) => c.name.startsWith("notes:")),
      `${commands.body?.length} commands left`,
    )

    const linksFor = await api.call(`/links/Account/${me.body.id}`, { headers: H })
    score.check(
      "the space's link disappears, with nothing changed in the account cube",
      !(linksFor.body?.groups ?? []).some((g) => g.cube === "notes"),
      `groups: ${JSON.stringify((linksFor.body?.groups ?? []).map((g) => g.label))}`,
    )
  }
  await stopServer(s3)

  // ============ 5. level 1: neither cube mentions the other ============
  //
  // The link between `notes` and `Account` is declared in `spaces/workspace/`. If either cube
  // named the other, the space would be decoration.
  cpSync(notesBackup, notesDir, { recursive: true })

  const readAll = (dir) => {
    let text = ""
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else text += readFileSync(p, "utf8")
      }
    }
    walk(dir)
    return text
  }

  const notesSource = readAll(notesDir)
  const accountSource = readAll(join(cubesDir, "account"))
  const spaceSource = readAll(join(coreDir, "src", "spaces", "workspace"))

  // The comment at the top of notes/index.ts talks about the rule, so the check is on CODE:
  // strip line comments and block comments before looking.
  const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  score.check(
    "the notes cube never names Account, anywhere in its code",
    !codeOnly(notesSource).includes("Account"),
    "grep over cubes/notes/ with comments stripped",
  )
  score.check(
    "the account cube never names notes, anywhere in its code",
    !/\bnotes\b/.test(codeOnly(accountSource)),
    "grep over cubes/account/ with comments stripped",
  )
  score.check(
    "the space is where both names appear together",
    spaceSource.includes("notes") && spaceSource.includes("Account"),
    "spaces/workspace/index.ts declares the link neither cube knows about",
  )
}
