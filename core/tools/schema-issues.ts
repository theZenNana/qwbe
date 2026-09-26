import { inspect } from "node:util"

// Pure text for schema errors. No I/O in this module.

export interface Issue {
  readonly path: ReadonlyArray<PropertyKey>
  readonly message: string
}

const valueAt = (input: unknown, path: ReadonlyArray<PropertyKey>) =>
  path.reduce<unknown>(
    (value, key) => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined),
    input,
  )

/** One line per issue: file, key path, what was expected, and the value found there in `input`. */
export const describeIssues = (file: string, input: unknown, issues: ReadonlyArray<Issue>) =>
  issues
    .map(
      ({ path, message }) =>
        `${file}: ${path.map(String).join(".") || "$"}: ${message}; value ${inspect(valueAt(input, path))}`,
    )
    .join("\n")
