// Runtime assets the TypeScript build does not emit.
//
// `tsc -p tsconfig.build.json` compiles src/**/*.ts into dist/, but the kernel also reads
// non-TypeScript files from disk relative to its own module: the numbered SQL migrations under
// src/pg/migrations are applied at boot by pg/db.ts (join(here, "migrations")). Without this
// copy the compiled kernel -- the one the tarball installs -- boots straight into ENOENT. If a
// later change adds another src-relative asset directory, copy it here too.
//
//   node scripts/build-assets.mjs     (run by `npm run build`, after tsc)

import { cpSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const core = join(dirname(fileURLToPath(import.meta.url)), "..")
const assets = [["src/pg/migrations", "dist/pg/migrations"]]

for (const [from, to] of assets) {
  const source = join(core, from)
  if (!existsSync(source)) {
    throw new Error(`build-assets: expected ${from} to exist -- the build cannot ship without it`)
  }
  cpSync(source, join(core, to), { recursive: true })
}
