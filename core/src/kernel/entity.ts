// What every entity shares, whatever cube holds it.
//
// No business field belongs here. `title` lives in the notes cube, `username` in account. If a
// business field lands here, two cubes can see it and they have coupled — and coupling through
// the kernel is harder to spot than an import, because it looks legitimate.

import { Schema } from "effect"

export const EntityMeta = {
  id: Schema.String,
  type: Schema.String,
  createdAt: Schema.String,
  deleted: Schema.Boolean,
}

// --- what a cube shows ABOUT ITSELF to other cubes ---
//
// When something wants to display "the author of this note", it may not know what columns an
// account has. It gets a summary: a title plus key/value pairs the owning cube chose. Each
// cube picks its own public representation and can change it without breaking anyone.

export const Pair = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
}).annotations({ identifier: "Pair" })

export const Summary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  details: Schema.Array(Pair),
}).annotations({ identifier: "Summary" })

export type SummaryRow = typeof Summary.Type
