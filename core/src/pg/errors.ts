// A cube asked for a table that is not its own.
//
// Throws rather than returning empty. A silent `[]` would look like "no data", the cube would
// be written on a false premise, and the bug would surface months later, far from its cause.
// Lives next to the Postgres store (its only thrower) and is re-exported from `store.ts`, the
// same door the kernel always used.

/**
 * The caps are checked per request by the kernel's fold, but a PATCH merge adds a few keys
 * at a time and can walk a row past both caps; custom-fold.ts catches this and answers 400.
 */
export class CustomCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CustomCapError"
  }
}

export class ForeignTableError extends Error {
  constructor(cube: string, table: string, own: ReadonlyArray<string>) {
    super(
      `Cube "${cube}" asked for table "${table}", which it does not own. ` +
        `It owns: [${own.join(", ")}]. ` +
        `Another cube's data is reached through the registry (search / summary), never through ` +
        `the store. If you genuinely need this table, declare it in your manifest -- but then it ` +
        `is yours, and nobody else may own it.`,
    )
    this.name = "ForeignTableError"
  }
}
