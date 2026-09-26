import { expect, it } from "@effect/vitest"
import { afterExit, prefixer, servicesOf } from "./dev.ts"

it("restarts on exit 0 with a doubling delay capped at 4 s", () => {
  expect(afterExit(0, 60_000, 0)).toEqual({ _tag: "Restart", delay: 250, quickExits: 1 })
  expect(afterExit(0, 100, 1)).toEqual({ _tag: "Restart", delay: 500, quickExits: 2 })
  expect(afterExit(0, 100, 4)).toEqual({ _tag: "Restart", delay: 4000, quickExits: 5 })
  expect(afterExit(0, 60_000, 4)).toEqual({ _tag: "Restart", delay: 250, quickExits: 1 })
})

it("stops on a nonzero exit and on the sixth quick clean exit", () => {
  expect(afterExit(3, 100, 0)).toMatchObject({ _tag: "Stop", status: 3 })
  expect(afterExit(0, 100, 5)).toMatchObject({ _tag: "Stop", status: 1 })
})

it("maps subcommands to services", () => {
  expect(servicesOf(undefined)).toEqual(["api", "web"])
  expect(servicesOf("api")).toEqual(["api"])
  expect(servicesOf("web")).toEqual(["web"])
  expect(servicesOf("db")).toBeUndefined()
})

it("prefixes lines, colored only on a terminal", () => {
  expect(prefixer("api", 36, false)("ready")).toBe("[api] ready")
  expect(prefixer("api", 36, true)("ready")).toBe("\x1b[36m[api]\x1b[0m ready")
})
