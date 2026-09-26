import { expect, it } from "@effect/vitest"
import { isOlder, parseVersion, withoutAllowScripts } from "./setup.ts"

it("compares Node versions part by part", () => {
  expect(parseVersion("v22.18.0")).toEqual([22, 18, 0])
  expect(isOlder([22, 17, 9], [22, 18, 0])).toBe(true)
  expect(isOlder([22, 18, 0], [22, 18, 0])).toBe(false)
  expect(isOlder([23, 0, 0], [22, 18, 0])).toBe(false)
  expect(isOlder([22], [22, 18, 0])).toBe(true)
})

it("strips allow-scripts in any case and nothing else", () => {
  expect(
    withoutAllowScripts({ npm_config_allow_scripts: "a", NPM_CONFIG_ALLOW_SCRIPTS: "b", npm_config_fund: "false" }),
  ).toEqual({ npm_config_allow_scripts: undefined, NPM_CONFIG_ALLOW_SCRIPTS: undefined })
})
