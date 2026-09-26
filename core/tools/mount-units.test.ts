import { expect, it } from "@effect/vitest"
import { unitOf, unitsOnlyUntracked } from "./mount-units.ts"

it("maps a path to its mount unit and skips hidden, underscored and outside paths", () => {
  expect(unitOf("core/plugins/crm-pack/cubes/a.ts")).toBe("core/plugins/crm-pack/")
  expect(unitOf("core/src/cubes/.cache/x")).toBeUndefined()
  expect(unitOf("core/src/spaces/_draft/x")).toBeUndefined()
  expect(unitOf("core/src/kernel/state.ts")).toBeUndefined()
})

it("reports only units with untracked files and nothing tracked", () => {
  const untracked = ["core/plugins/new/a.ts", "core/plugins/old/extra.ts"]
  const tracked = ["core/plugins/old/index.ts"]
  expect(unitsOnlyUntracked(untracked, tracked)).toEqual(["core/plugins/new/"])
})
