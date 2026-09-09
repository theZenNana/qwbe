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
import type { RowState } from "./store.ts"

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
  /**
   * Echo A2: the DECLARED entity type whose rows the kernel store captures for this cube
   * (entity-enforcement `captureEntity`): the manifest's `entity`, except for the identity
   * directory and non-entity cubes. Undefined means "no captured rows can exist for this
   * cube" -- and, since the entry only exists while the cube is mounted, also "not a live
   * capture source right now". This is the narrow resolver the echo feed reads BEFORE any
   * access: existence and current capture identity, never inferred from a summary.
   */
  readonly captureEntity?: string | undefined
  /**
   * Echo A3: the kernel-built row STATE lookup on this cube's OWN store (`rowStateFor`):
   * `{ id, type, deleted }` only, never a body. Present only for capture sources; wired in
   * `main.ts` next to `captureEntity`, never handed to a cube.
   */
  readonly state?: ((id: string) => Effect.Effect<RowState | undefined>) | undefined
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
    /**
     * Echo A2: the cube's CURRENT capture entity, or undefined when the cube is absent,
     * switched off, holds no declared entity, or IS the identity directory. The feed checks
     * this before touching activity rows, so a stale row pointing at a cube that no longer
     * captures (or never did) never reaches a summary call.
     */
    readonly captureOf: (cube: string) => string | undefined
    /**
     * Echo A3: the CURRENT state (`{ id, type, deleted }`, no body) of one row of a cube's
     * capture entity, from the owning store under the owning role. Undefined when the cube is
     * absent, switched off, not a capture source, or holds no such row -- so a caller can
     * tell "deleted" from "missing" without ever reading the activity log as truth.
     */
    readonly targetState: (cube: string, id: string) => Effect.Effect<RowState | undefined>
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
