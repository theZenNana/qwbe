import { inspect } from "node:util"
import * as ParseResult from "effect/ParseResult"

const valueAt = (input: unknown, path: ReadonlyArray<PropertyKey>) =>
  path.reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined),
    input,
  )

/** One line per schema issue: file, key path, what was expected, and the value found there. */
export const describeIssues = (file: string, input: unknown, error: ParseResult.ParseError) =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map((issue) => {
      const where = issue.path.map(String).join(".") || "$"
      return `${file}: ${where}: ${issue.message}; value ${inspect(valueAt(input, issue.path))}`
    })
    .join("\n")
