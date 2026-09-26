import { expect, it } from "@effect/vitest"
import {
  dataDirFor,
  INSTALL_ARGV,
  INSTALL_DIRS,
  installFailedMessage,
  meetsRequired,
  nodeOkMessage,
  tooOldMessage,
} from "./setup-pure.ts"

it("meetsRequired decides on the first differing part", () => {
  expect(meetsRequired("v22.17.9")).toBe(false)
  expect(meetsRequired("21.99.99")).toBe(false)
  expect(meetsRequired("v22.18.0")).toBe(true)
  expect(meetsRequired("22.22.1")).toBe(true)
  expect(meetsRequired("v23.0.0")).toBe(true)
  expect(meetsRequired("22.18")).toBe(true)
})

it("installs root, core, web in that order with npm ci", () => {
  expect(INSTALL_DIRS).toEqual([".", "core", "web"])
  expect(INSTALL_ARGV).toEqual(["npm", "ci", "--no-audit", "--no-fund"])
})

it("messages name the version, the requirement and the failed dir", () => {
  expect(nodeOkMessage("v24.1.0")).toBe("node v24.1.0: ok (need >= 22.18.0)")
  expect(tooOldMessage("v20.0.0")).toContain("Qwbe needs Node 22.18.0 or newer; you have v20.0.0.")
  expect(installFailedMessage("web", 2)).toBe("npm ci failed in web (exit 2); nothing after it ran")
})

it("dataDirFor prefers QWBE_DATA_DIR over root/data", () => {
  expect(dataDirFor("/repo/", undefined)).toBe("/repo/data")
  expect(dataDirFor("/repo/", "/var/qwbe")).toBe("/var/qwbe")
})
