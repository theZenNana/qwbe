// The registry — how cubes see each other without importing each other.
//
//   1. A space declares "notes.authorId points at Account, and shows up as `notes`".
//   2. Each cube provides a search-in-me function returning `Summary` — the public shape it
//      chose for itself.
//   3. Nobody asks a cube directly. They ask the registry, built from the cubes that are
//      actually mounted and actually enabled.
//
// Two things differ from the previous iteration, both in the contract:
//   - `search` takes a page request and returns `{ rows, total }`;
//   - a cube's functions arrive already bound to its own store (`Effect<..., never, never>`),
//     so no caller can slip in a different one.

import { Context, Effect, Layer } from "effect"
import type { SummaryRow } from "./entity.ts"
import type { RelationalPart, SearchResult } from "./manifest.ts"
import type { PageRequest } from "./pagination.ts"
import type { Link } from "./space.ts"

export type RegistryEntry = {
  readonly name: string
  /**
   * `| undefined` for the same reason as `PageRequest.sortBy`: every caller builds this from a
   * manifest, where `entity` is optional, so what arrives is `string | undefined`. Under
   * `exactOptionalPropertyTypes`, `entity?: string` means "absent or a string" and rejects it —
   * the type would describe a registry nobody builds.
   */
  readonly entity?: string | undefined
  readonly relational?: RelationalPart | undefined
}

export type LinkGroup = {
  readonly cube: string
  readonly label: string
  readonly field: string
}

const EMPTY: SearchResult = { rows: [], total: 0 }

export class Registry extends Context.Tag("cubes/Registry")<
  Registry,
  {
    /** Who points at this entity, among currently active cubes. Comes from the spaces. */
    readonly linksTo: (entity: string) => ReadonlyArray<LinkGroup>
    /** The links declared FOR this cube — i.e. what its own rows point at. */
    readonly linksFrom: (cube: string) => ReadonlyArray<Link>
    readonly search: (
      cube: string,
      field: string,
      value: string,
      page: PageRequest,
    ) => Effect.Effect<SearchResult, never, never>
    /** A summary, asked of the cube that holds the entity. Referential integrity without joins. */
    readonly summary: (entity: string, id: string) => Effect.Effect<SummaryRow | undefined, never, never>
    readonly fieldValue: (cube: string, id: string, field: string) => Effect.Effect<string | null, never, never>
    readonly entities: () => ReadonlyArray<{ readonly cube: string; readonly entity: string }>
  }
>() {}

/**
 * Built from the mounted cubes plus the links the spaces declare.
 *
 * Both are filtered per call, not once at startup: a cube switched off in Settings is, to the
 * registry, exactly a cube that was never mounted — it answers nothing, appears in nobody's
 * related lists, and its tab disappears from the UI, because the frontend takes its tabs from
 * here.
 *
 * A missing or disabled cube yields an empty result, never an error. "Decoupled" means "not
 * there", not "crashed".
 */
export const registryFrom = (
  entries: ReadonlyArray<RegistryEntry>,
  liveLinks: () => ReadonlyArray<Link>,
  isEnabled: (cube: string) => boolean,
) => {
  const live = () => entries.filter((e) => isEnabled(e.name))

  return Layer.succeed(Registry, {
    linksTo: (entity) =>
      liveLinks()
        .filter((l) => l.to === entity)
        .map((l) => ({ cube: l.from, label: l.label, field: l.field })),

    linksFrom: (cube) => liveLinks().filter((l) => l.from === cube),

    search: (cube, field, value, page) => {
      const e = live().find((x) => x.name === cube)
      if (!e?.relational?.search) return Effect.succeed(EMPTY)
      return e.relational.search(field, value, page)
    },

    summary: (entity, id) => {
      const e = live().find((x) => x.entity === entity)
      if (!e?.relational?.summaryById) return Effect.succeed(undefined)
      return e.relational.summaryById(id)
    },

    fieldValue: (cube, id, field) => {
      const e = live().find((x) => x.name === cube)
      if (!e?.relational?.fieldValue) return Effect.succeed(null)
      return e.relational.fieldValue(id, field)
    },

    entities: () =>
      live()
        .filter((e) => !!e.entity)
        .map((e) => ({ cube: e.name, entity: e.entity as string })),
  })
}
