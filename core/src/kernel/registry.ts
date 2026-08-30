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

import { Context, type Effect } from "effect"
import type { CurrentUser } from "./auth-contract.ts"
import type { RelationalPart, SearchResult, SummaryRow } from "./entity.ts"
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
  readonly permissionExempt?: boolean | undefined
}

export type LinkGroup = {
  readonly cube: string
  readonly label: string
  readonly field: string
}

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
    ) => Effect.Effect<SearchResult, never, CurrentUser>
    /** A summary, asked of the cube that holds the entity. Referential integrity without joins. */
    readonly summary: (
      entity: string,
      id: string,
      caller?: typeof CurrentUser.Service,
    ) => Effect.Effect<SummaryRow | undefined>
    readonly fieldValue: (
      cube: string,
      id: string,
      field: string,
      caller?: typeof CurrentUser.Service,
    ) => Effect.Effect<string | null>
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
