import { expect, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PKG, PKG_CUBE, plantBookmarksCopy } from "../_layers/pack-copy.ts"
import { bootedAsAdmin, type Session } from "../_layers/session.ts"
import { testWorkspace } from "../_layers/test-server.ts"
import { Workspace } from "../_layers/workspace.ts"

// Replaces probes/lifecycle.mjs, lifecycle-life.mjs and install-from-life.mjs: a package goes
// from the shelf into a running system and back out across three boots over the same database
// and directories. Install and uninstall take effect only at the next boot.

const Cubes = Schema.Array(Schema.Struct({ name: Schema.String }))
const Packages = Schema.Array(Schema.Struct({ name: Schema.String, installed: Schema.Boolean }))
const Changed = Schema.Struct({ requiresRestart: Schema.Literal(true) })

const INSTALL = ["POST", `/settings/packages/${PKG}/install`] as const
const UNINSTALL = ["DELETE", `/settings/packages/${PKG}`] as const

const mounted = (admin: Session) =>
  admin.get("/settings/cubes").pipe(
    Effect.flatMap((reply) => Schema.decodeUnknown(Cubes)(reply.body)),
    Effect.map((cubes) => cubes.map(({ name }) => name)),
  )

const installedFlag = (admin: Session) =>
  admin.get("/settings/packages").pipe(
    Effect.flatMap((reply) => Schema.decodeUnknown(Packages)(reply.body)),
    Effect.map((shelf) => shelf.find(({ name }) => name === PKG)?.installed),
  )

// 200 with requiresRestart: true, or the test fails naming what came back.
const changePackage = (admin: Session, [method, path]: typeof INSTALL | typeof UNINSTALL) =>
  admin.send(method, path).pipe(
    Effect.filterOrDie(
      (reply) => reply.status === 200 && Schema.is(Changed)(reply.body),
      (reply) => new Error(`${method} ${path} answered ${reply.status} ${JSON.stringify(reply.body)}`),
    ),
  )

// Installed on disk, not mounted yet: the drift the settings screen shows until the restart.
const installPending = (admin: Session) =>
  Effect.gen(function* () {
    yield* changePackage(admin, INSTALL)
    expect(yield* installedFlag(admin)).toBe(true)
    expect(yield* mounted(admin)).not.toContain(PKG_CUBE)
    expect(yield* admin.status(`/${PKG_CUBE}`)).toBe(404)
  })

// Mounted and writable; uninstalled it keeps answering until the restart, and the kept shelf
// lets it come back and go again without a source directory.
const useThenRemove = (admin: Session) =>
  Effect.gen(function* () {
    expect(yield* mounted(admin)).toContain(PKG_CUBE)
    const row = { label: "Proba", targetCube: "notes", url: "https://example.org/proba" }
    expect((yield* admin.send("POST", `/${PKG_CUBE}`, row)).status).toBe(200)
    yield* changePackage(admin, UNINSTALL)
    expect(yield* admin.status(`/${PKG_CUBE}`)).toBe(200)
    yield* changePackage(admin, INSTALL)
    yield* changePackage(admin, UNINSTALL)
    expect(yield* admin.status("/auth/me")).toBe(200)
  })

const gone = (admin: Session) =>
  Effect.gen(function* () {
    expect(yield* admin.status(`/${PKG_CUBE}`)).toBe(404)
    expect(yield* mounted(admin)).not.toContain(PKG_CUBE)
  })

layer(testWorkspace("lifecycle"), { timeout: 120_000, excludeTestServices: true })((it) => {
  it.effect("installs, mounts after a restart, uninstalls, and is gone after the next restart", () =>
    Effect.gen(function* () {
      yield* plantBookmarksCopy((yield* Workspace).storeDir)
      yield* bootedAsAdmin(installPending)
      yield* bootedAsAdmin(useThenRemove)
      yield* bootedAsAdmin(gone)
    }),
  )
})
