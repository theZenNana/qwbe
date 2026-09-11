// QWB-69: unit tests for the workspace space. A space declares connections BETWEEN cubes,
// so these tests pin the declared links themselves (the third-party contract) and use the
// kernel's own `danglingLinks` validation to prove a half-mounted space reports honestly
// instead of silently showing empty lists.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { danglingLinks } from "../../kernel/space.ts"
import { space } from "./index.ts"

describe("workspace space contract (QWB-69)", () => {
  it("carries the workspace title and exactly the declared links", () => {
    assert.equal(space.name, "workspace")
    assert.equal(space.title, "Workspace")
    assert.equal(space.links.length, 3)
  })

  it("links notes.authorId to Account as the 'notes' group", () => {
    const link = space.links.find((l) => l.from === "notes")
    assert.ok(link)
    assert.equal(link!.field, "authorId")
    assert.equal(link!.to, "Account")
    assert.equal(link!.label, "notes")
  })

  it("declares the crm/contracts party link and the booktags tags link", () => {
    const party = space.links.find((l) => l.from === "crm/contracts")
    assert.ok(party)
    assert.equal(party!.field, "partyId")
    assert.equal(party!.to, "Contact")
    assert.equal(party!.label, "party")

    const tags = space.links.find((l) => l.from === "booktags/tags")
    assert.ok(tags)
    assert.equal(tags!.field, "bookmarkId")
    assert.equal(tags!.to, "Bookmark")
    assert.equal(tags!.label, "tags")
  })

  it("reports dangling links honestly when only notes is mounted", () => {
    // The negative case: with most cubes absent, validation names each missing end
    // instead of the UI quietly showing an empty list.
    const dangling = danglingLinks([space], [{ name: "notes", entity: "Note" }])
    assert.equal(dangling.length, 3)
    for (const d of dangling) {
      assert.equal(d.space, "workspace")
      assert.ok(d.reason.includes("no cube named") || d.reason.includes("no mounted cube holds entity"))
    }
    // And with both ends present, nothing dangles.
    const full = danglingLinks(
      [space],
      [
        { name: "notes", entity: "Note" },
        { name: "account", entity: "Account" },
        { name: "crm/contracts", entity: "Contract" },
        { name: "crm/contacts", entity: "Contact" },
        { name: "booktags/tags", entity: "Tag" },
        { name: "booktags/bookmarks", entity: "Bookmark" },
      ],
    )
    assert.deepEqual(full, [])
  })
})
