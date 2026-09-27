// The per-request source of custom-field DEFINITIONS, and the one-row view of custom VALUES.
//
// The definitions the kernel validates against must be
// read from the providing cube's own store AT REQUEST TIME -- an in-process snapshot is stale
// the moment a second API instance on the same database defines a field. A failed read here
// fails its caller, so a request whose validation cannot be answered answers 500 instead of
// validating on empty.

import { Context, Effect } from "effect"
import type { CustomFieldDefinition } from "./custom-field-types.ts"

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

/**
 * The custom-field definitions of one mount: what the kernel validates a request against
 * (`definitions`, read per request from the providers' own stores) and what the catalogue
 * publishes (`active`). Handlers reach it through this tag; `main.ts` provides the mount's.
 */
export class CustomFields extends Context.Tag("qwbe/CustomFields")<
  CustomFields,
  {
    /** The active definitions for a target cube, read per request. No reader registered (no
     *  provider mounted) means an empty list and the fold stays off -- still honest. */
    readonly definitions: (cube: string) => Effect.Effect<ReadonlyArray<CustomFieldDefinition>, unknown>
    /** The in-process definitions a provider published for a target cube. Pure read. */
    readonly active: (cube: string) => ReadonlyArray<CustomFieldDefinition>
  }
>() {}

/**
 * One mount's registry. Cubes register during their synchronous `create` (the cube-facing tool
 * returns void), so the lists are plain arrays owned by the mount; nothing registers after it.
 */
export const customFieldsRegistry = () => {
  const providers: Array<(cube: string) => ReadonlyArray<CustomFieldDefinition>> = []
  const readers: Array<CustomFieldDefsReader> = []
  const service: Context.Tag.Service<CustomFields> = {
    definitions: (cube) => Effect.forEach(readers, (read) => read(cube)).pipe(Effect.map((lists) => lists.flat())),
    active: (cube) => providers.flatMap((provide) => provide(cube)),
  }
  return {
    registerProvider: (provide: (cube: string) => ReadonlyArray<CustomFieldDefinition>): void => {
      providers.push(provide)
    },
    registerDefsReader: (reader: CustomFieldDefsReader): void => {
      readers.push(reader)
    },
    service,
  }
}

export type CustomFieldsRegistry = ReturnType<typeof customFieldsRegistry>
