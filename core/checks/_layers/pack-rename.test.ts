import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "@effect/vitest"
import { PKG_CUBE, renameBookmarks } from "./pack-rename.ts"
import { CORE } from "./workspace.ts"

const source = readFileSync(
  join(CORE, "plugins", "example-plugin", "cubes", "booktags", "bookmarks", "index.ts"),
  "utf8",
)
const renamed = renameBookmarks(source)

it("drops the parent, the sibling import and the original cache table", () => {
  expect(renamed).not.toMatch(/^\s*parent: "booktags"|from "\.\.\/events\.ts"|"settings-cache"/m)
})

it("renames the cube, its permissions, events and cache table", () => {
  for (const name of [`name: "${PKG_CUBE}"`, `"${PKG_CUBE}:read"`, `"${PKG_CUBE}.created"`, `"${PKG_CUBE}-cache"`]) {
    expect(renamed).toContain(name)
  }
})
