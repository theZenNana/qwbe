import { expect, it } from "@effect/vitest"
import { composeArgv } from "./db.ts"

it("maps up and down to docker compose and refuses anything else", () => {
  expect(composeArgv("up")).toEqual(["docker", "compose", "up", "-d", "postgres"])
  expect(composeArgv("down")).toEqual(["docker", "compose", "down"])
  expect(composeArgv(undefined)).toBeUndefined()
  expect(composeArgv("clean")).toBeUndefined()
})
