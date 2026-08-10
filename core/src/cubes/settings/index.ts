// The SETTINGS cube — minimal, as asked: switch cubes on and off, and show what is installed.
//
// It is the only cube with `managesCubes: true`. The privilege is DECLARED in its manifest, in
// the open: `grep -r managesCubes src/cubes/ plugins/` returns the complete list of privileged
// cubes in the system, and the kernel refuses to start if two ask for it.
//
// Why that shape matters: exemptions kept in a central config file accumulate. Each one arrives
// with a good reason and a ticket, none with an expiry date, and after ten of them the gate is
// a register. A privilege declared by the cube that wants it cannot be slipped in without a
// visible diff in that cube's own directory.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden, NotFound } from "../../kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../kernel/manifest.ts"
import { CubeState } from "./contract.ts"

const Toggle = Schema.Struct({ enabled: Schema.Boolean }).annotations({ identifier: "Toggle" })

/** A package offered by the store, and whether it is already on disk. */
const PackageState = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("cube", "plugin"),
  summary: Schema.String,
  /** For a plugin, the cubes it brings; for a cube, itself. */
  cubes: Schema.Array(Schema.String),
  installed: Schema.Boolean,
  bytes: Schema.Number,
  /**
   * Cube names this package would collide with, given what is on disk right now.
   *
   * In the contract rather than only enforced, so a client can grey the button out and say why
   * before the click. Two store packages both brought a cube called `contacts`; installing the
   * second was accepted, and the NEXT STARTUP died — the kernel refuses duplicate names, and
   * rightly. From a button in a web page, "the server will not come up" is the worst possible
   * way to learn that.
   */
  conflicts: Schema.Array(Schema.String),
}).annotations({ identifier: "PackageState" })

/**
 * What an install actually did.
 *
 * `requiresRestart` is in the contract, not in a comment, because the kernel discovers cubes at
 * startup: the directory is on disk but nothing is mounted yet. A response that listed the new
 * routes as if they were live would be a lie the caller cannot check.
 */
const InstallResult = Schema.Struct({
  package: PackageState,
  requiresRestart: Schema.Boolean,
}).annotations({ identifier: "InstallResult" })

const RemoveResult = Schema.Struct({
  removed: Schema.String,
  requiresRestart: Schema.Boolean,
}).annotations({ identifier: "RemoveResult" })

const RestartResult = Schema.Struct({
  restarting: Schema.Boolean,
  message: Schema.String,
}).annotations({ identifier: "RestartResult" })

/**
 * How the API restarts itself. The process must hand its life to something that will bring it
 * back — otherwise the button would kill the server for good. Declared as an environment
 * variable with a default that fits the systemd unit the nest runs (`qwbe.service`):
 *
 *   inband  — exit(0); systemd's Restart=always brings it back. Default.
 *   command — run QWBE_RESTART_CMD (e.g. `systemctl --user restart qwbe`); for a manually
 *             started server. The request answers BEFORE the restart fires.
 */

const group = HttpApiGroup.make("settings")
  .add(HttpApiEndpoint.get("cubes")`/settings/cubes`.addSuccess(Schema.Array(CubeState)).addError(Forbidden))
  .add(
    HttpApiEndpoint.post("toggle")`/settings/cubes/${HttpApiSchema.param("name", Schema.String)}`
      .setPayload(Toggle)
      .addSuccess(CubeState)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(HttpApiEndpoint.get("packages")`/settings/packages`.addSuccess(Schema.Array(PackageState)).addError(Forbidden))
  .add(
    HttpApiEndpoint.post("install")`/settings/packages/${HttpApiSchema.param("name", Schema.String)}/install`
      .addSuccess(InstallResult)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("uninstall")`/settings/cubes/${HttpApiSchema.param("name", Schema.String)}`
      .addSuccess(RemoveResult)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  // The counterpart of `install`, and the reason it exists: installing does not mount, and the
  // route above takes a MOUNTED cube. Without this, a package installed and not yet restarted
  // into could not be taken back — you would have to restart in order to mount the very thing
  // you wanted gone.
  .add(
    HttpApiEndpoint.del("uninstallPackage")`/settings/packages/${HttpApiSchema.param("name", Schema.String)}`
      .addSuccess(RemoveResult)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  // The banner says "ask for the API to be restarted". This is the button for it. Guarded by
  // settings:write like every other mutation here — a reader cannot bounce the server.
  .add(
    HttpApiEndpoint.post("restart")`/settings/restart`
      .addSuccess(RestartResult)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .middleware(Authorization)

export const cube: CubeDefinition = {
  manifest: {
    name: "settings",
    tables: [],
    requiresAuth: true,
    // Required: a cube that could switch itself off would be the last thing you ever did in
    // the system. The kernel refuses it anyway, so the rule sits in two places on purpose.
    required: true,
    managesCubes: true,
    permissions: [
      { name: "settings:read", roles: ["admin", "reader"] },
      { name: "settings:write", roles: ["admin"] },
    ],
  },

  create: ({ catalogue, switches, installer }: CubeTools) => {
    if (!switches || !installer) {
      // Cannot happen — the manifest asks for the privilege and the kernel grants it on that
      // basis. If it does, it is a kernel bug, and failing at startup beats a 500 on the first
      // click.
      throw new Error("settings asked for `managesCubes: true` but received no switches/installer — kernel bug")
    }

    const state = (name: string) => {
      const c = catalogue().find((x) => x.name === name)
      if (!c) return undefined
      return {
        name: c.name,
        enabled: c.enabled,
        required: c.required,
        system: c.system,
        plugin: c.plugin,
        onDisk: installer.cubeOnDisk(c.name, c.plugin),
        entity: c.entity ?? null,
        screen: c.screen,
        publishes: c.publishes,
        links: c.links,
      }
    }

    return {
      group,

      commands: [
        {
          name: "settings:cubes",
          summary: "list cubes and whether they are on",
          permission: "settings:read",
          run: () =>
            Effect.succeed(
              catalogue()
                .map((c) => `${c.enabled ? "on " : "off"}  ${c.name}${c.plugin ? `  (plugin: ${c.plugin})` : ""}`)
                .join("\n"),
            ),
        },
      ],

      handlers: {
        cubes: () =>
          Effect.gen(function* () {
            yield* requirePermission("settings:read")
            // A function, not a value: the list reflects the state of NOW. The frontend draws
            // its tabs from this response.
            return catalogue().map((c) => state(c.name)!)
          }),

        toggle: ({ path, payload }: { path: { name: string }; payload: { enabled: boolean } }) =>
          Effect.gen(function* () {
            yield* requirePermission("settings:write")
            if (!state(path.name)) {
              return yield* Effect.fail(new NotFound({ message: `cube ${path.name} is not mounted` }))
            }
            // Each refusal keeps its own meaning: a required cube is a bad request, a cube that
            // is not mounted is a 404, and a disk that would not take the write is neither —
            // it is not the caller's fault, so it is not dressed up as their mistake. The
            // kernel's wording is passed through; it already says what was refused and why.
            yield* switches.set(path.name, payload.enabled).pipe(
              Effect.catchTags({
                RequiredCubeError: (e) => Effect.fail(new BadRequest({ message: e.message })),
                UnknownCubeError: (e) => Effect.fail(new NotFound({ message: e.message })),
                // Deliberately a defect, not a status: the request was well formed and the
                // machine failed. It belongs in the logs as a broken server, not in the
                // response as a rejected caller.
                StateFileError: (e) => Effect.die(e),
              }),
            )
            return state(path.name)!
          }),

        packages: () =>
          Effect.gen(function* () {
            yield* requirePermission("settings:read")
            return installer.available()
          }),

        install: ({ path }: { path: { name: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("settings:write")
            const pkg = yield* Effect.try({
              try: () => installer.install(path.name),
              // Every refusal from the installer already says what was refused and why —
              // unknown package, bad name, destination taken. Rewriting them into a generic
              // message would hide exactly the part the caller needs.
              catch: (e) => new BadRequest({ message: (e as Error).message }),
            })
            // Not mounted yet: the kernel reads the disk at startup. Said in the response
            // rather than hoped for.
            return { package: pkg, requiresRestart: true }
          }),

        uninstall: ({ path }: { path: { name: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("settings:write")
            const current = state(path.name)
            if (!current) {
              return yield* Effect.fail(new NotFound({ message: `cube ${path.name} is not mounted` }))
            }
            if (current.required) {
              // Same reason a required cube cannot be switched off, one step more final:
              // deleting `auth` from a web page removes the way back in.
              return yield* Effect.fail(
                new BadRequest({
                  message:
                    `Cube "${path.name}" is required and cannot be removed. ` +
                    `Without it the system could not be brought back from the UI.`,
                }),
              )
            }
            const result = yield* Effect.try({
              try: () => installer.remove(path.name, current.plugin),
              catch: (e) => new BadRequest({ message: (e as Error).message }),
            })
            return { removed: result.removed, requiresRestart: true }
          }),

        uninstallPackage: ({ path }: { path: { name: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("settings:write")
            // A package from the store cannot BE a required cube — required ones ship with core
            // and are not in the store. Checked anyway rather than reasoned about, because that
            // sentence is true today and is exactly the kind that stops being true quietly.
            const mounted = catalogue()
              .filter((c) => c.required)
              .map((c) => c.name)
            const pkg = installer.available().find((p) => p.name === path.name)
            const clash = (pkg?.cubes ?? []).filter((c) => mounted.includes(c))
            if (clash.length > 0) {
              return yield* Effect.fail(
                new BadRequest({ message: `Refused: that package holds required cube(s): ${clash.join(", ")}.` }),
              )
            }
            const result = yield* Effect.try({
              try: () => installer.uninstallPackage(path.name),
              catch: (e) => new BadRequest({ message: (e as Error).message }),
            })
            return { removed: result.removed, requiresRestart: true }
          }),

        restart: () =>
          Effect.gen(function* () {
            yield* requirePermission("settings:write")
            // The spawning lives in the kernel, borrowed through `installer` — a cube may not
            // touch `node:child_process`, and this was the repository's last such violation.
            installer.restart()
            return { restarting: true, message: "API repornește — revino în câteva secunde." }
          }),
      },
    }
  },
}
