// The invariant probe. This is the reason the prototype exists:
//
//     ONE CUBE = ONE DIRECTORY. INSTALLING IT TOUCHES NO EXISTING FILE.
//
// Not checked by reading code, but by doing it: take a SHA-256 fingerprint of every file under
// `core/`, create a cube, install a plugin, start the server, call their routes — and only
// then compare the fingerprints. If any existing file changed, the invariant is a story rather
// than a property.
//
// Four parts:
//   1. a new cube in `src/cubes/` — the core path
//   2. a new PLUGIN in `plugins/` bringing its own cube — the third-party path
//   3. removing a real cube from disk — the server must still start
//   4. the level-1 claim: neither linked cube mentions the other, anywhere
//
// It cleans up after itself in `finally`, so a failure halfway does not leave the tree dirty.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cubeSource, fingerprints } from "./decoupling-fixtures.mjs"
import { cubeRemovedFromDisk, notesBackup, notesDir } from "./decoupling-removal.mjs"
import { client, coreDir, dropScratch, freePort, makeScore, scratchDataDir, startServer, stopServer } from "./lib.mjs"

// Own port, own databases — see `lib.mjs`. This probe restarts the server three times, and all
// three boots must read the same directory, so it is resolved once here.
const PORT = await freePort()
const dataDir = scratchDataDir("decoupling")
const score = makeScore()
const api = client(PORT)

const cubesDir = join(coreDir, "src", "cubes")
const pluginsDir = join(coreDir, "plugins")

const PROBE_CUBE = "zprobecube"
const PROBE_PLUGIN = "zprobeplugin"
const PROBE_PLUGIN_CUBE = "widgets"

const probeCubeDir = join(cubesDir, PROBE_CUBE)
const probePluginDir = join(pluginsDir, PROBE_PLUGIN)

try {
  rmSync(probeCubeDir, { recursive: true, force: true })
  rmSync(probePluginDir, { recursive: true, force: true })

  const before = fingerprints(coreDir)

  // ============ 1. a new cube in core ============
  mkdirSync(probeCubeDir, { recursive: true })
  // depth 2: src/cubes/<name>/index.ts → ../../kernel/
  writeFileSync(join(probeCubeDir, "index.ts"), cubeSource(PROBE_CUBE, 2), "utf8")

  // ============ 2. a new plugin bringing a cube ============
  const pluginCubeDir = join(probePluginDir, "cubes", PROBE_PLUGIN_CUBE)
  mkdirSync(pluginCubeDir, { recursive: true })
  // depth 4: plugins/<p>/cubes/<name>/index.ts → ../../../../src/kernel/
  writeFileSync(
    join(pluginCubeDir, "index.ts"),
    cubeSource(PROBE_PLUGIN_CUBE, 4).replace(/\.\.\/kernel\//g, "../src/kernel/"),
    "utf8",
  )

  const s1 = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
  score.check(
    "server starts with a new cube and a new plugin on disk",
    s1.alive,
    s1.alive ? "" : s1.output.slice(0, 400),
  )

  if (s1.alive) {
    const session = await api.login()
    const H = session.headers

    const fromCore = await api.call(`/${PROBE_CUBE}/hello`, { headers: H })
    score.check("the new core cube's route answers", fromCore.status === 200, `http=${fromCore.status}`)

    const fromPlugin = await api.call(`/${PROBE_PLUGIN_CUBE}/hello`, { headers: H })
    score.check(
      "the plugin cube's route answers, same as any other",
      fromPlugin.status === 200,
      `http=${fromPlugin.status}`,
    )

    const cubes = await api.call("/settings/cubes", { headers: H })
    const names = (cubes.body ?? []).map((c) => c.name)
    score.check(
      "both appear in the catalogue without being registered anywhere",
      names.includes(PROBE_CUBE) && names.includes(PROBE_PLUGIN_CUBE),
      `catalogue: ${names.join(", ")}`,
    )
    score.check(
      "the catalogue names the plugin a cube came from",
      (cubes.body ?? []).find((c) => c.name === PROBE_PLUGIN_CUBE)?.plugin === PROBE_PLUGIN,
      `plugin=${(cubes.body ?? []).find((c) => c.name === PROBE_PLUGIN_CUBE)?.plugin}`,
    )

    const spec = await api.call("/openapi.json")
    score.check(
      "both routes are in the emitted OpenAPI, so Swagger shows them",
      !!spec.body?.paths?.[`/${PROBE_CUBE}/hello`] && !!spec.body?.paths?.[`/${PROBE_PLUGIN_CUBE}/hello`],
      `${Object.keys(spec.body?.paths ?? {}).length} paths`,
    )

    const me = await api.call("/auth/me", { headers: H })
    score.check(
      "their permissions reached auth without auth being edited",
      me.body?.permissions?.includes(`${PROBE_CUBE}:read`) &&
        me.body?.permissions?.includes(`${PROBE_PLUGIN_CUBE}:read`),
      `${me.body?.permissions?.length} permissions`,
    )

    const commands = await api.call("/cli/commands", { headers: H })
    score.check(
      "their commands reached the CLI without the cli cube being edited",
      (commands.body ?? []).some((c) => c.name === `${PROBE_CUBE}:ping`) &&
        (commands.body ?? []).some((c) => c.name === `${PROBE_PLUGIN_CUBE}:ping`),
      `${commands.body?.length} commands`,
    )
  }
  await stopServer(s1)

  // ============ the measurement ============
  const after = fingerprints(coreDir)
  const changed = []
  for (const [path, hash] of before) {
    if (!after.has(path)) changed.push(`${path} (deleted)`)
    else if (after.get(path) !== hash) changed.push(`${path} (modified)`)
  }
  const added = [...after.keys()].filter((p) => !before.has(p))

  score.check(
    "INVARIANT: installing a cube and a plugin touched no existing file",
    changed.length === 0,
    changed.length === 0
      ? `${before.size} files untouched, ${added.length} added: ${added.join(", ")}`
      : `TOUCHED: ${changed.join(", ")}`,
  )

  // ============ 3. uninstall by deleting the directory ============
  rmSync(probeCubeDir, { recursive: true, force: true })
  rmSync(probePluginDir, { recursive: true, force: true })

  const s2 = await startServer(PORT, { QWBE_DATA_DIR: dataDir })
  score.check("server starts after both directories are deleted", s2.alive, s2.alive ? "" : s2.output.slice(0, 400))
  if (s2.alive) {
    const spec = await api.call("/openapi.json")
    score.check(
      "their routes are gone from OpenAPI",
      !spec.body?.paths?.[`/${PROBE_CUBE}/hello`] && !spec.body?.paths?.[`/${PROBE_PLUGIN_CUBE}/hello`],
    )
  }
  await stopServer(s2)

  const afterRemoval = fingerprints(coreDir)
  const removalChanges = []
  for (const [path, hash] of before) {
    if (!afterRemoval.has(path)) removalChanges.push(`${path} (deleted)`)
    else if (afterRemoval.get(path) !== hash) removalChanges.push(`${path} (modified)`)
  }
  for (const path of afterRemoval.keys()) {
    if (!before.has(path)) removalChanges.push(`${path} (added)`)
  }
  score.check(
    "uninstalling left no trace in any other file",
    removalChanges.length === 0,
    removalChanges.length === 0
      ? `${afterRemoval.size} files, identical to the starting state`
      : removalChanges.join(", "),
  )

  // Sections 4 and 5 — the cube DELETED from disk, and the level-1 claim that neither linked
  // cube names the other — live in `decoupling-removal.mjs`. Same probe, same server pattern,
  // same `score`; a separate file because this one outgrew its size cap and that was the seam
  // already drawn. The `finally` below still restores `notes`, from the same two paths.
  await cubeRemovedFromDisk({ api, score, port: PORT, dataDir })
} finally {
  rmSync(probeCubeDir, { recursive: true, force: true })
  rmSync(probePluginDir, { recursive: true, force: true })
  if (existsSync(notesBackup)) {
    if (!existsSync(notesDir)) cpSync(notesBackup, notesDir, { recursive: true })
    rmSync(notesBackup, { recursive: true, force: true })
  }
  dropScratch(dataDir)
}

process.exit(score.report("Invariant probe"))
