// Unit tests for the space graph — links between cubes that never import each other.
//
// A dangling link is invisible in the UI: `to: "Acount"` renders as an empty list, which looks
// exactly like "no data". No boundary tool can catch it, because the whole point is that there
// is no import. So it is checked here, and here it is tested.

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { activeLinks, danglingLinks, defineSpace, type Link, link, type SpaceDefinition } from "./space.ts"

const workspace = (...links: ReadonlyArray<Link>): SpaceDefinition =>
  defineSpace({ name: "workspace", title: "Workspace", links })

const pointing = (from: string, to: string): Link => link({ from, field: `${to.toLowerCase()}Id`, to, label: from })

const noteToAccount = pointing("notes", "Account")

const cubes = [
  { name: "notes", entity: "Note" },
  { name: "account", entity: "Account" },
  { name: "cli" }, // no entity: a cube can exist without holding data
]

describe("danglingLinks", () => {
  it("finds nothing when both ends exist", () => {
    assert.deepEqual(danglingLinks([workspace(noteToAccount)], cubes), [])
  })

  it("reports a link whose source cube is not mounted", () => {
    const broken = pointing("ghost", "Account")
    const found = danglingLinks([workspace(broken)], cubes)
    assert.equal(found.length, 1)
    assert.equal(found[0]?.space, "workspace")
    assert.match(found[0]?.reason ?? "", /no cube named "ghost"/)
  })

  // The typo that started this: `Acount` instead of `Account`.
  it("reports a link to an entity nobody holds", () => {
    const typo = pointing("notes", "Acount")
    const found = danglingLinks([workspace(typo)], cubes)
    assert.equal(found.length, 1)
    assert.match(found[0]?.reason ?? "", /no mounted cube holds entity "Acount"/)
  })

  it("does not treat a cube name as an entity name", () => {
    const wrongEnd = pointing("notes", "account")
    assert.equal(danglingLinks([workspace(wrongEnd)], cubes).length, 1)
  })

  it("reports one reason per link, source checked before target", () => {
    const both = pointing("ghost", "Acount")
    const found = danglingLinks([workspace(both)], cubes)
    assert.equal(found.length, 1, "a link with two problems still produces one entry")
    assert.match(found[0]?.reason ?? "", /no cube named/)
  })

  it("walks every space, not just the first", () => {
    const other = defineSpace({ name: "erp", title: "ERP", links: [pointing("ghost", "Account")] })
    const found = danglingLinks([workspace(noteToAccount), other], cubes)
    assert.deepEqual(
      found.map((f) => f.space),
      ["erp"],
    )
  })
})

describe("activeLinks — a switched-off cube has no links", () => {
  const all = () => true

  it("returns a link whose two ends are mounted and enabled", () => {
    assert.deepEqual(activeLinks([workspace(noteToAccount)], cubes, all), [noteToAccount])
  })

  it("drops the link when the SOURCE cube is switched off", () => {
    assert.deepEqual(
      activeLinks([workspace(noteToAccount)], cubes, (c) => c !== "notes"),
      [],
    )
  })

  // This is what makes "disabled" mean "does not exist" rather than "returns errors": the tab
  // vanishes from the other cube's page as well.
  it("drops the link when the TARGET cube is switched off", () => {
    assert.deepEqual(
      activeLinks([workspace(noteToAccount)], cubes, (c) => c !== "account"),
      [],
    )
  })

  it("drops a link to an entity nobody holds instead of throwing", () => {
    const typo = pointing("notes", "Acount")
    assert.deepEqual(activeLinks([workspace(typo)], cubes, all), [])
  })

  it("is consulted per call, so the same input follows the switch", () => {
    const spaces = [workspace(noteToAccount)]
    let enabled = true
    const isEnabled = () => enabled
    assert.equal(activeLinks(spaces, cubes, isEnabled).length, 1)
    enabled = false
    assert.equal(activeLinks(spaces, cubes, isEnabled).length, 0)
  })
})
