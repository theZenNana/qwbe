// The one failure of the API route benchmark: its message is what runTool prints.
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

export class ApiBenchFailed extends Data.TaggedError("ApiBenchFailed")<{ readonly message: string }> {}

export const failIfAny = (findings: ReadonlyArray<string>) =>
  findings.length === 0 ? Effect.void : Effect.fail(new ApiBenchFailed({ message: findings.join("\n") }))
