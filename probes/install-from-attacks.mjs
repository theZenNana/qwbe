// The attacks the review of QWB-15 asked probes for, kept apart from the flow they attack.
//
// Split out of `install-from-life.mjs` when that file crossed the 6000-character cap: these
// are the refusals - symlink as root, plain file as path, FIFO in the tree, a manifest
// promising a cube the directory does not carry, and a shelf edited after staging.

import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The refusals the review asked probes for: symlink as root, a plain file as the path, a FIFO
 * inside the tree, a manifest promising a cube the directory does not carry, and a shelf
 * modified after staging answering as "different content".
 */
export const reviewAttacks = async ({ api, admin, store, fixtures }) => {
  const verdicts = []
  const say = (name, ok, detail = "") => verdicts.push({ name, ok, detail })
  const post = (body) =>
    api.call("/settings/packages/install-from", { method: "POST", headers: admin, body: JSON.stringify(body) })

  const link = await post({ path: fixtures.linkRoot })
  say(
    "a symlink AS the root is refused - not followed",
    link.status === 400 && String(link.body?.message).includes("symlink"),
    `http=${link.status} - the first version statSync'd through it`,
  )

  const file = await post({ path: fixtures.filePath })
  say(
    "a path that is a plain file is refused",
    file.status === 400 && String(file.body?.message).includes("not a directory"),
    `http=${file.status}`,
  )

  const fifo = await post({ path: fixtures.fifoDir })
  say(
    "a FIFO inside the tree is refused like any special file",
    fifo.status === 400 && String(fifo.body?.message).includes("special file"),
    `http=${fifo.status}`,
  )

  const ghost = await post({ path: fixtures.ghostDir })
  say(
    "a manifest promising a missing cube is refused",
    ghost.status === 400 && String(ghost.body?.message).includes("cubes/ghostcube"),
    `http=${ghost.status}`,
  )

  const badTypes = await post({ path: fixtures.badTypesDir })
  say(
    "a TypeScript-invalid cube is refused before publication",
    badTypes.status === 400 && String(badTypes.body?.message).includes("TypeScript contract gate"),
    `http=${badTypes.status}`,
  )

  // The shelf trust attack: stage the good package, EDIT the staged copy, then offer the
  // original source again. The shelf's fingerprint is recomputed from disk, so the edit must
  // answer as "different content" - not inherit the provenance stamp.
  const first = await post({ path: fixtures.goodDir })
  say("stage for the shelf-edit attack", first.status === 200, `http=${first.status}`)
  await api.call("/settings/packages/dirplugin", { method: "DELETE", headers: admin })
  writeFileSync(join(store, "dirplugin", "cubes", "dirbookmarks", "index.ts"), "// edited on the shelf\n")
  const edited = await post({ path: fixtures.goodDir })
  say(
    "a shelf edited after staging answers as DIFFERENT content, not identical",
    edited.status === 400 && String(edited.body?.message).includes("different content"),
    `http=${edited.status} - trusting qwbe-source.json would have installed the edit`,
  )
  rmSync(join(store, "dirplugin"), { recursive: true, force: true })
  return verdicts
}
