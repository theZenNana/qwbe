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
import { Authorization, requirePermission } from "qwbe-core/auth"
import { type CubeTools, decodeCubeEnabled, defineCube } from "qwbe-core/cube"
import { EntityMeta } from "qwbe-core/entity"
import { Forbidden, NotFound } from "qwbe-core/errors"
import { PageOf } from "qwbe-core/http"
import { PageParams, pageRequest } from "qwbe-core/pagination"

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
  .add(
    HttpApiEndpoint.get("list")`/booktags-settings`
      .setUrlParams(PageParams)
      .addSuccess(PageOf(Setting))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("set")`/booktags-settings/${HttpApiSchema.param("key", Schema.String)}`
      .setPayload(SettingSet)
      .addSuccess(Setting)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

export const cube = defineCube(group, {
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

  create: ({ store, bus }: CubeTools) => ({
    // The kernel announces a re-enabled cube on `qwbe/cube.enabled`. When the bookmarks
    // sibling comes back on, this cube RE-PUBLISHES its current settings -- the bus is
    // fire-and-forget, so anything set while the sibling was off never reached it. The
    // subscriber's cache update is idempotent, so a redundant event is harmless.
    subscriptions: [
      {
        event: "qwbe/cube.enabled",
        handle: (payload) =>
          Effect.gen(function* () {
            const { cube } = decodeCubeEnabled(payload)
            if (cube !== "booktags/bookmarks") return
            const rows = yield* store.all<SettingRow>(TABLE)
            for (const row of rows) {
              yield* bus.publish("booktags/settings.changed", { key: row.key, value: row.value })
            }
          }),
      },
    ],

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
      list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
        Effect.gen(function* () {
          yield* requirePermission("booktags/settings:read")
          return yield* store.page<SettingRow>(TABLE, pageRequest(urlParams))
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
})
