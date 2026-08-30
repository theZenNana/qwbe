// Everything the install routes must REFUSE: path traversal, and the permission wall.
//
// These two belong together because they are the same claim from two directions — a write that
// should never happen. The checks that PASS here are the ones that were turned away.
//
// The validator is called twice on purpose, once through HTTP and once directly. Three of the
// traversal names came back 404 rather than 400: the HTTP router normalised the URL and never
// reached the handler. That is a refusal by accident of routing, and routing changes. So the
// guard is also called with no HTTP in the way, to prove it does not depend on the layer above.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { coreDir, root } from "./lib.mjs"

const TRAVERSALS = [
  ["..", "the parent directory"],
  ["../../../etc", "an absolute escape"],
  ["..%2f..%2fetc", "percent-encoded separators"],
  ["a/b", "a nested path"],
  ["a\\b", "a Windows separator"],
  [".", "the current directory"],
  ["Probecube", "uppercase — the pattern is lowercase-only"],
  ["probe.cube", "a dot, which is how `..` gets in"],
  ["probecube ", "a trailing space"],
  ["", "an empty name"],
]

const DIRECT_NAMES = [
  "..",
  ".",
  "",
  "../../../etc/passwd",
  "a/b",
  "a\\b",
  "/absolute",
  "C:\\win",
  "probe.cube",
  "PROBE",
]

const DIRECT_REMOVALS = [
  ["..", null],
  ["ok", ".."],
  ["ok", "../../etc"],
  ["", null],
]

export const traversalIsRefused = async ({ api, score, admin }) => {
  for (const [name, why] of TRAVERSALS) {
    const r = await api.call(`/settings/packages/${encodeURIComponent(name)}/install`, {
      method: "POST",
      headers: admin.headers,
    })
    score.check(
      `traversal: install "${name}" is refused (${why})`,
      r.status >= 400 && r.status < 500,
      `http=${r.status}`,
    )
  }

  score.check(
    "traversal: nothing was created outside the cubes directory",
    !existsSync(join(root, "etc")) && !existsSync(join(coreDir, "src", "a")),
    "checked on disk, not inferred from the status codes",
  )

  const { installerFor, InstallError } = await import(join(coreDir, "src", "kernel", "install.ts"))
  // effect resolves from core's own node_modules -- probes sit outside that package scope.
  const { createRequire } = await import("node:module")
  const { Effect } = createRequire(join(coreDir, "package.json"))("effect")
  const direct = installerFor()

  for (const name of DIRECT_NAMES) {
    let refused = false
    let why = ""
    // runPromiseExit, not runPromise: a typed failure arrives as an Exit carrying the error,
    // not as a rejected promise wrapped in FiberFailure -- the instanceof must see the error.
    const exit = await Effect.runPromiseExit(direct.install(name))
    if (exit._tag === "Failure") {
      refused = exit.cause.error instanceof InstallError
      why = exit.cause.error?.name ?? "failure without InstallError"
    }
    score.check(`validator: install("${name}") is refused with no HTTP in the way`, refused, why || "no throw")
  }

  for (const [cube, plugin] of DIRECT_REMOVALS) {
    const exit = await Effect.runPromiseExit(direct.remove(cube, plugin))
    const refused = exit._tag === "Failure" && exit.cause.error instanceof InstallError
    score.check(`validator: remove("${cube}", ${JSON.stringify(plugin)}) is refused`, refused)
  }
}

export const permissionsHold = async ({ api, score, reader, planted }) => {
  const readerInstall = await api.call("/settings/packages/probecube/install", {
    method: "POST",
    headers: reader.headers,
  })
  score.check(
    "permissions: a reader cannot install — 403",
    readerInstall.status === 403,
    `http=${readerInstall.status}`,
  )

  const anonInstall = await api.call("/settings/packages/probecube/install", { method: "POST" })
  score.check("permissions: no token cannot install", anonInstall.status === 401, `http=${anonInstall.status}`)

  const anonList = await api.call("/settings/packages")
  score.check("permissions: no token cannot even list the store", anonList.status === 401, `http=${anonList.status}`)

  const readerRemove = await api.call("/settings/cubes/notes", { method: "DELETE", headers: reader.headers })
  score.check("permissions: a reader cannot remove a cube", readerRemove.status === 403, `http=${readerRemove.status}`)

  score.check(
    "permissions: none of the refused attempts left anything on disk",
    !existsSync(planted),
    "the refusals were real, not cosmetic",
  )
}
