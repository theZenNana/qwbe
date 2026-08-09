// The ERP SETTINGS cube — the ERP's own settings area.
//
// The owner asked for it in those words: the ERP must have "a zone of its own" for its settings,
// and each module should carry the settings that belong to it. This cube is that zone. It does
// NOT extend the core `settings` cube, and could not: `settings` owns no tables at all — it is
// the on/off switchboard for cubes, nothing more — so there is no key store anywhere in core to
// write `erp.*` into, and adding one would mean editing a cube that is not ours. Which is the
// one thing this architecture forbids.
//
// So the plugin brings its own settings cube, in its own directory, with its own table. That is
// the invariant working as intended rather than a workaround: a module's settings arrive with
// the module and leave with it.
//
// The keys are DECLARED below. An unknown key is refused rather than stored, because a settings
// store that accepts anything becomes a junk drawer, and nobody can then say which keys matter.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Effect, Schema } from "effect"
import { Authorization, requirePermission } from "../../../../src/kernel/auth-contract.ts"
import { EntityMeta, type SummaryRow } from "../../../../src/kernel/entity.ts"
import { Forbidden, NotFound } from "../../../../src/kernel/errors.ts"
import type { CubeDefinition, CubeTools } from "../../../../src/kernel/manifest.ts"
import { PageOf, PageParams, pageRequest } from "../../../../src/kernel/pagination.ts"

const TABLE = "erp_settings"
const ENTITY = "ErpSetting"

/** Answered by this cube, listened to by the cubes that care. Both sides know only the string. */
const SETTINGS_REQUESTED = "erp.settings.requested"
const SETTINGS_CHANGED = "erp.settings.changed"

/**
 * The keys this ERP has, with their defaults.
 *
 * A key is a contract: something reads it. `erp.accountNumberPrefix` and
 * `erp.contactNumberPrefix` decide what the numbers on new records look like, and
 * `erp.defaultIndustry` fills the industry of a company created without one. Changing any of
 * them has a visible effect on the very next record — checked in `probes/erp.mjs`, so none of
 * them can quietly become decoration.
 */
const KNOWN = [
  {
    key: "erp.accountNumberPrefix",
    value: "ACC",
    label: "Account number prefix",
    description: "Prefix of the human-facing number on a new company, e.g. ACC-0001.",
  },
  {
    key: "erp.contactNumberPrefix",
    value: "CON",
    label: "Contact number prefix",
    description: "Prefix of the human-facing number on a new contact, e.g. CON-0001.",
  },
  {
    key: "erp.defaultIndustry",
    value: "",
    label: "Default industry",
    description: "Used when a company is created without an industry. Empty means leave it blank.",
  },
] as const

const ErpSetting = Schema.Struct({
  ...EntityMeta,
  key: Schema.String,
  value: Schema.String,
  label: Schema.String,
  description: Schema.String,
}).annotations({ identifier: "ErpSetting" })

const ErpSettingWrite = Schema.Struct({ value: Schema.String }).annotations({ identifier: "ErpSettingWrite" })

type ErpSettingRow = typeof ErpSetting.Type

const group = HttpApiGroup.make("erp-settings")
  .add(
    HttpApiEndpoint.get("list")`/erp-settings`
      .setUrlParams(PageParams)
      .addSuccess(PageOf(ErpSetting))
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("get")`/erp-settings/${HttpApiSchema.param("key", Schema.String)}`
      .addSuccess(ErpSetting)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.put("set")`/erp-settings/${HttpApiSchema.param("key", Schema.String)}`
      .setPayload(ErpSettingWrite)
      .addSuccess(ErpSetting)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)

const summary = (s: ErpSettingRow): SummaryRow => ({
  id: s.id,
  title: s.label,
  details: [
    { key: "key", value: s.key },
    { key: "value", value: s.value },
  ],
})

export const cube: CubeDefinition = {
  manifest: {
    name: "erp-settings",
    tables: [TABLE],
    entity: ENTITY,
    sortable: ["key", "label", "createdAt"],
    requiresAuth: true,
    permissions: [
      { name: "erp-settings:read", roles: ["admin", "reader"] },
      // Writing a setting changes how every new record is numbered, so it is an admin action.
      { name: "erp-settings:write", roles: ["admin"] },
    ],
    publishes: [SETTINGS_CHANGED],
  },

  create: ({ store, bus }: CubeTools) => {
    /**
     * Seed on first use, not in `create`.
     *
     * `create` runs while the system is still mounting: the bus refuses to publish there, and a
     * write would happen before anyone could listen. Seeding lazily also means an existing
     * database keeps its values and only gains keys added later.
     */
    const seed = Effect.gen(function* () {
      const rows = yield* store.all<ErpSettingRow>(TABLE)
      const present = new Set(rows.map((r) => r.key))
      for (const k of KNOWN) {
        if (present.has(k.key)) continue
        yield* store.insert(TABLE, ENTITY, "set", {
          key: k.key,
          value: k.value,
          label: k.label,
          description: k.description,
        })
      }
    })

    const find = (key: string) =>
      Effect.gen(function* () {
        yield* seed
        const rows = yield* store.all<ErpSettingRow>(TABLE)
        return rows.find((r) => r.key === key)
      })

    return {
      group,

      /**
       * The answer half of the bus conversation.
       *
       * A cube that needs `erp.contactNumberPrefix` cannot open this database — that is the
       * isolation — so it publishes a request naming the keys it wants, and this cube publishes
       * each current value back. Delivery is synchronous, so by the time the asker's publish
       * returns, its cache holds the real values. With this cube absent or switched off nobody
       * answers and the asker keeps its own defaults.
       */
      subscriptions: [
        {
          event: SETTINGS_REQUESTED,
          handle: (payload: unknown) =>
            Effect.gen(function* () {
              const wanted = (payload as { keys?: unknown })?.keys
              const keys = Array.isArray(wanted) ? wanted.filter((k): k is string => typeof k === "string") : []
              yield* seed
              const rows = yield* store.all<ErpSettingRow>(TABLE)
              for (const r of rows) {
                if (keys.length > 0 && !keys.includes(r.key)) continue
                yield* bus.publish(SETTINGS_CHANGED, { key: r.key, value: r.value })
              }
            }),
        },
      ],

      commands: [
        {
          name: "erp-settings:show",
          summary: "the ERP settings and their current values",
          permission: "erp-settings:read",
          run: () =>
            Effect.gen(function* () {
              yield* seed
              const rows = yield* store.all<ErpSettingRow>(TABLE)
              return rows.map((r) => `${r.key}\t${r.value}`).join("\n") || "(none)"
            }),
        },
      ],

      handlers: {
        list: ({ urlParams }: { urlParams: typeof PageParams.Type }) =>
          Effect.gen(function* () {
            yield* requirePermission("erp-settings:read")
            yield* seed
            return yield* store.page<ErpSettingRow>(TABLE, pageRequest(urlParams))
          }),

        get: ({ path }: { path: { key: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("erp-settings:read")
            const s = yield* find(path.key)
            if (!s) return yield* Effect.fail(new NotFound({ message: `no ERP setting called ${path.key}` }))
            return s
          }),

        set: ({ path, payload }: { path: { key: string }; payload: { value: string } }) =>
          Effect.gen(function* () {
            yield* requirePermission("erp-settings:write")
            const s = yield* find(path.key)
            // An unknown key is a 404, not a new row. Nothing reads it, so storing it would only
            // produce a settings page full of values that do nothing.
            if (!s) return yield* Effect.fail(new NotFound({ message: `no ERP setting called ${path.key}` }))
            const updated = (yield* store.update(TABLE, s.id, { value: payload.value })) as unknown as ErpSettingRow
            // Told, not polled: whoever cached this key hears about it now.
            yield* bus.publish(SETTINGS_CHANGED, { key: updated.key, value: updated.value })
            return updated
          }),
      },

      relational: {
        search: (field, value, page) =>
          Effect.gen(function* () {
            const p = yield* store.page<ErpSettingRow>(TABLE, page, { field, value })
            return { rows: p.rows.map(summary), total: p.total }
          }),

        summaryById: (id) =>
          Effect.gen(function* () {
            const s = yield* store.byId<ErpSettingRow>(TABLE, id)
            return s ? summary(s) : undefined
          }),
      },
    }
  },
}
