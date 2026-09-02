// The request fold, split out of runtime-composition.ts (QWB-54 ticket 05: the file was at its
// cap). This is the one wrapper that owns the custom-value POLICY at request time:
//
//   - defect 4: the definitions come from the provider's OWN STORE, read per request through
//     the registered reader (custom-defs-reader.ts). An in-process snapshot is stale the moment
//     a second API instance on the same database defines a field, and its silent failure used
//     to skip validation. A failed read dies here -- the request answers 500, it does not
//     validate on an empty list.
//   - defect 1: POST handlers fold in "create" mode, so a required definition with no value in
//     the request is a 400 before the row exists; PATCH and PUT fold in "patch" mode, where
//     only a key that is PRESENT and empty is refused.
//   - defect 2: a store merge that grew past the caps throws CustomCapError; this wrapper is
//     the one place that owns the custom policy, so it is the one place that turns that into a
//     400 the caller can act on.
//
// The caller (runtime-composition.ts) decides WHICH endpoints get wrapped: it reads the
// payload schema, widens it, checks isStructSchema and computes `declared` and the mode. This
// module only wraps, so nothing here needs to import the schema-widening machinery back.

import { Effect } from "effect"
import { definitionsFromStore } from "./custom-defs-reader.ts"
import { foldCustom } from "./custom-values.ts"
import { BadRequest } from "./kernel/errors.ts"
import { CustomCapError } from "./pg/errors.ts"

export const withCustomFold = (
  cubeName: string,
  declared: ReadonlyArray<string>,
  mode: "create" | "patch",
  implementation: unknown,
) => {
  const impl = implementation as (request: unknown) => Effect.Effect<unknown, unknown>
  return (request: unknown) =>
    Effect.gen(function* () {
      const defs = yield* Effect.orDie(definitionsFromStore(cubeName))
      if (typeof request === "object" && request !== null && !Array.isArray(request) && "payload" in request) {
        const folded = foldCustom(request.payload, declared, defs, mode)
        if (!folded.ok) return yield* Effect.fail(new BadRequest({ message: folded.message }))
        return yield* impl({ ...request, payload: folded.payload })
      }
      return yield* impl(request)
    }).pipe(
      Effect.catchAllDefect((defect) =>
        defect instanceof CustomCapError
          ? Effect.fail(new BadRequest({ message: defect.message }))
          : Effect.die(defect),
      ),
    )
}
