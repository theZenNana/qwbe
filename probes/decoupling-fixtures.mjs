// The material the invariant probe works with: how to fingerprint a tree, and what a
// throwaway cube looks like.
//
// Neither of these asserts anything — they are the fixtures, and the probe next door is the
// story. Keeping them apart means `decoupling.mjs` reads as a sequence of claims rather than
// as a claim with a code generator wedged in the middle of it.
//
// `cubeSource` takes an import DEPTH rather than a path because the same source has to work
// from two places at two different distances from the kernel: `src/cubes/<name>/index.ts` is
// two levels down, `plugins/<p>/cubes/<name>/index.ts` is four. A cube that hardcoded its own
// depth would be a cube that only installs in one of the two places the system offers.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { coreDir } from "./lib.mjs"

/** Fingerprint every file under a directory. Key is the path relative to `core/`. */
export const fingerprints = (dir) => {
  const out = new Map()
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue
      // Stale links (e.g. a venv lib64) must not crash fingerprinting.
      if (entry.isSymbolicLink()) continue
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (statSync(p).isFile()) {
        out.set(relative(coreDir, p), createHash("sha256").update(readFileSync(p)).digest("hex"))
      }
    }
  }
  walk(dir)
  return out
}

export const cubeSource = (name, importDepth) => {
  const up = "../".repeat(importDepth)
  return `import { HttpApiEndpoint, HttpApiGroup } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "${up}kernel/auth-contract.ts"
import { Forbidden } from "${up}kernel/errors.ts"

const Hello = Schema.Struct({ message: Schema.String })

const group = HttpApiGroup.make("${name}")
  .add(HttpApiEndpoint.get("hello")\`/${name}/hello\`.addSuccess(Hello).addError(Forbidden))
  .middleware(Authorization)

export const cube = {
  manifest: {
    name: "${name}",
    tables: [],
    requiresAuth: true,
    permissions: [{ name: "${name}:read", roles: ["admin"] }],
  },
  create: () => ({
    group,
    commands: [
      {
        name: "${name}:ping",
        summary: "prove a command can arrive with a cube",
        permission: "${name}:read",
        run: () => Effect.succeed("pong"),
      },
    ],
    handlers: {
      hello: () =>
        Effect.gen(function* () {
          yield* requirePermission("${name}:read")
          return { message: "installed without touching any existing file" }
        }),
    },
  }),
}
`
}
