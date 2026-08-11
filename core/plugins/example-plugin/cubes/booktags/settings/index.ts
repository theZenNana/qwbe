// The third child of Booktags -- its configuration, as data.
//
// One real setting, `enforceTargetCube`: when "strict", the bookmarks child refuses a
// bookmark that carries an arbitrary `url` -- Booktags bookmarks point at cubes, nothing
// else. When "relaxed" (the default), a URL is allowed alongside the cube reference.
//
// The value reaches `booktags/bookmarks` through the BUS, one of the four legal paths:
// this cube publishes `booktags/settings.changed` on every write; the sibling subscribes
// and keeps its own cache in its own store. Neither cube imports the other, and deleting
// either leaves the other honest: bookmarks simply runs on its default.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../../src/kernel/auth-contract.ts"
import { EntityMeta } from "../../../../../src/kernel/entity.ts"
import { Forbidden, NotFound } from "../../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../../src/kernel/manifest.ts"

const TABLE = "settings"

const Setting = Schema.Struct({
  ...EntityMeta,
  key: Schema.String,
  value: Schema.String,
}).annotations({ identifier: "BooktagsSetting" })

const SettingSet = Schema.Struct({
  value: Schema.String,
}).annotations({ identifier: "BooktagsSettingSet" })

type SettingRow = typeof Setting.Type

const KNOWN = new Set(["enforceTargetCube"])
const VALUES = new Set(["strict", "relaxed"])

const group = HttpApiGroup.make("booktags-settings")
  .add(HttpApiEndpoint.get("list")`/booktags-settings`.addSuccess(Schema.Array(Setting)).addError(Forbidden))
  .add(
    HttpApiEndpoint.post("set")`/booktags-settings/${HttpApiSchema.param("key", Schema.String)}`
      .setPayload(SettingSet)
      .addSuccess(Setting)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

export const cube: CubeDefinition = {
  manifest: {
    name: "settings",
    parent: "booktags",
    tables: [TABLE],
    entity: "BooktagsSetting",
    requiresAuth: true,
    permissions: [
      { name: "booktags/settings:read", roles: ["admin", "reader"] },
      { name: "booktags/settings:write", roles: ["admin"] },
    ],
    publishes: ["booktags/settings.changed"],
  },

  create: ({ store, bus, catalogue }: CubeTools) => ({
    group,

    commands: [
      {
        name: "booktags/settings:get",
        summary: "the current value of enforceTargetCube",
        permission: "booktags/settings:read",
        run: () =>
          Effect.gen(function* () {
            const rows = yield* store.all<SettingRow>(TABLE)
            const row = rows.find((r) => r.key === "enforceTargetCube")
            return `enforceTargetCube = ${row?.value ?? "relaxed (default)"}`
          }),
      },
    ],

    handlers: {
      list: () =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/settings:read")
          const rows = yield* store.all<SettingRow>(TABLE)
          // Replay: the bus is fire-and-forget and skips a subscriber that is switched off,
          // so a setting changed while bookmarks was down would never reach it. The first
          // request after any toggle re-publishes the CURRENT values -- the subscriber's
          // cache update is idempotent, so a redundant event is harmless. The kernel's
          // catalogue() reports enablement live; there is no signal INTO create, so the edge
          // is the only place a re-publish can be triggered from.
          const bookmarksOn = catalogue().some((c) => c.name === "booktags/bookmarks" && c.enabled)
          if (bookmarksOn) {
            for (const row of rows) yield* bus.publish("booktags/settings.changed", { key: row.key, value: row.value })
          }
          return rows
        }),

      set: ({ path, payload }: { path: { key: string }; payload: typeof SettingSet.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/settings:write")
          if (!KNOWN.has(path.key) || !VALUES.has(payload.value)) {
            return yield* Effect.fail(
              new NotFound({
                message: `unknown setting "${path.key}" or value "${payload.value}" -- known: enforceTargetCube = strict | relaxed`,
              }),
            )
          }
          const rows = yield* store.all<SettingRow>(TABLE)
          const existing = rows.find((r) => r.key === path.key)
          const row = existing
            ? ((yield* store.update(TABLE, existing.id, { value: payload.value })) as SettingRow)
            : ((yield* store.insert(TABLE, "BooktagsSetting", "bts", {
                key: path.key,
                value: payload.value,
              })) as SettingRow)
          // The sibling hears about it here -- never through a shared table or an import.
          yield* bus.publish("booktags/settings.changed", { key: row.key, value: row.value })
          return row
        }),
    },
  }),
}
