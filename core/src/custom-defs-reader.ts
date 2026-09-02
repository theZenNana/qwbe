// The per-request source of custom-field DEFINITIONS, and the one-row view of custom VALUES.
//
// The definitions the kernel validates against must be
// read from the providing cube's own store AT REQUEST TIME -- an in-process snapshot is stale
// the moment a second API instance on the same database defines a field. A failed read here
// fails its caller, so a request whose validation cannot be answered answers 500 instead of
// validating on empty.

import { Effect } from "effect"
import type { CustomFieldDefinition } from "./catalogue.ts"

/** One target row's custom values, as the providing cube reads them from the row itself. */
export type CustomRowView = {
  readonly id: string
  readonly custom: Record<string, unknown>
  readonly deleted: boolean
}

/**
 * A reader that fetches a target cube's ACTIVE definitions from the provider's own store. The
 * error channel is unknown on purpose: a failed read is a store failure, and the caller decides
 * what that means (a 500, never validate-on-empty).
 */
export type CustomFieldDefsReader = (cube: string) => Effect.Effect<ReadonlyArray<CustomFieldDefinition>, unknown>

const readers: Array<CustomFieldDefsReader> = []

/** Called by the kernel at mount, once per cube declaring `providesCustomFields`. */
export const registerCustomFieldDefsReader = (reader: CustomFieldDefsReader): void => {
  readers.push(reader)
}

/**
 * The active definitions for a target cube, read per request. No readers registered (no
 * provider mounted) means an empty list and the fold stays off -- the pre-customfields
 * behavior, still honest.
 */
export const definitionsFromStore = (cube: string): Effect.Effect<ReadonlyArray<CustomFieldDefinition>, unknown> =>
  Effect.forEach(readers, (read) => read(cube)).pipe(Effect.map((lists) => lists.flat()))
