// The settings cube's CLI commands.
//
// Split out of `index.ts` on 10 Aug 2026, when QWB-15's `settings:install-from` pushed that
// file to 9670 code characters against a 6000 cap. The seam is the one the cube contract
// already draws: HTTP handlers stay with the routes, command specs live here. Both receive the
// same `installer` capability - if the two adapters ever disagree about what the kernel said,
// that is the bug, not the arrangement.

import { Effect } from "effect"
import type { CubeTools } from "../../kernel/manifest.ts"

type Installer = NonNullable<CubeTools["installer"]>
type Catalogue = CubeTools["catalogue"]

export const settingsCommands = (catalogue: Catalogue, installer: Installer) => [
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
  {
    name: "settings:install-from",
    summary: "install a plugin from a directory - `settings:install-from <absolute-path>`",
    permission: "settings:write",
    maxArgs: 1,
    run: (args: readonly string[]) =>
      Effect.gen(function* () {
        const sourcePath = args[0]
        if (!sourcePath) {
          return yield* Effect.fail("usage: settings:install-from <absolute-path>")
        }
        // The same kernel function the HTTP endpoint calls - one validation, one set of
        // errors, two thin adapters.
        const result = yield* Effect.try({
          try: () => installer.stageAndInstall(sourcePath),
          catch: (e) => (e as Error).message,
        })
        return (
          `installed ${result.name} (${result.kind}, cubes: ${result.cubes.join(", ")}) ` +
          `${result.staged ? "staged in store" : "reused identical store copy"} - restart required`
        )
      }),
  },
]
