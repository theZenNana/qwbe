import { Effect, Layer } from "effect"
import type { SearchResult } from "./kernel/manifest.ts"
import { Registry, type RegistryEntry } from "./kernel/registry.ts"
import type { Link } from "./kernel/space.ts"
import { protectRelational, type RelationalGate, relationalReadAllowed } from "./relational-enforcement.ts"

const EMPTY: SearchResult = { rows: [], total: 0 }

export const registryFrom = (
  entries: ReadonlyArray<RegistryEntry>,
  liveLinks: () => ReadonlyArray<Link>,
  isEnabled: (cube: string) => boolean,
  permissions?: RelationalGate,
) => {
  const protectedEntries = permissions ? entries.map((entry) => protectRelational(entry, permissions)) : entries
  const live = () => protectedEntries.filter((entry) => isEnabled(entry.name))
  return Layer.succeed(Registry, {
    linksTo: (entity) =>
      liveLinks()
        .filter((link) => link.to === entity)
        .map((link) => ({ cube: link.from, label: link.label, field: link.field })),
    linksFrom: (cube) => liveLinks().filter((link) => link.from === cube),
    search: (cube, field, value, page) => {
      const entry = live().find((candidate) => candidate.name === cube)
      return entry?.relational?.search ? entry.relational.search(field, value, page) : Effect.succeed(EMPTY)
    },
    summary: (entity, id, caller) => {
      const entry = live().find((candidate) => candidate.entity === entity)
      if (!entry?.relational?.summaryById) return Effect.succeed(undefined)
      if (!permissions) return entry.relational.summaryById(id)
      return Effect.flatMap(relationalReadAllowed(entry, permissions, caller, id), (ok) =>
        ok ? entry.relational!.summaryById!(id) : Effect.succeed(undefined),
      )
    },
    fieldValue: (cube, id, field, caller) => {
      const entry = live().find((candidate) => candidate.name === cube)
      if (!entry?.relational?.fieldValue) return Effect.succeed(null)
      if (!permissions) return entry.relational.fieldValue(id, field)
      return Effect.flatMap(relationalReadAllowed(entry, permissions, caller, id), (ok) =>
        ok ? entry.relational!.fieldValue!(id, field) : Effect.succeed(null),
      )
    },
    entities: () =>
      live()
        .filter((entry) => !!entry.entity)
        .map((entry) => ({ cube: entry.name, entity: entry.entity! })),
  })
}
