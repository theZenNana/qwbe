// QWB-69: unit tests for the workspace space. A space declares connections BETWEEN cubes,
// so these tests pin the declared links themselves (the third-party contract) and use the
// kernel's own `danglingLinks` validation to prove a half-mounted space reports honestly
// instead of silently showing empty lists.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { danglingLinks } from "../../kernel/space.ts"
import { space } from "./index.ts"

describe("workspace space contract (QWB-69)", () => {
  it("carries the workspace title and exactly the three declared links, verbatim", () => {
    assert.equal(space.name, "workspace")
    assert.equal(space.title, "Workspace")
    assert.deepEqual(space.links, [
      { from: "notes", field: "authorId", to: "Account", label: "notes" },
      { from: "crm/contracts", field: "partyId", to: "Contact", label: "party" },
      { from: "booktags/tags", field: "bookmarkId", to: "Bookmark", label: "tags" },
    ])
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
