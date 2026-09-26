import { basename } from "node:path"
import { IS_TEST } from "../src/package-size.ts"

/** Pure: true when `files` hold source code and not a single test file. */
export const lacksTests = (files: ReadonlyArray<string>) => {
  const tests = files.filter((file) => IS_TEST.test(basename(file)))
  return tests.length === 0 && files.length > 0
}
