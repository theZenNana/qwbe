import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  permissionsListPath,
  visibilityMutationPath,
  visibilityOptions,
  visibilityPresentation,
} from "./permissions-ui.ts"

describe("permissions list UI contract", () => {
  it("sends provenance and hidden filters to the server", () => {
    assert.equal(
      permissionsListPath("crm/contacts", { view: "shared-with-me", offset: 20, limit: 10 }),
      "/permissions/entities/crm%2Fcontacts?view=shared-with-me&offset=20&limit=10",
    )
  })

  it("keeps every provenance view visible in one compact filter row", () => {
    assert.deepEqual(visibilityOptions(3), [
      { value: "all", label: "Toate" },
      { value: "owned-by-me", label: "Ale mele" },
      { value: "created-by-me", label: "Create de mine" },
      { value: "only-mine", label: "Doar ale mele" },
      { value: "shared-by-me", label: "Partajate de mine" },
      { value: "shared-with-me", label: "Partajate cu mine" },
      { value: "hidden-by-me", label: "Ascunse: 3" },
    ])
  })

  it("targets one entity without allowing path segments to escape", () => {
    assert.equal(
      visibilityMutationPath({ cube: "crm/contacts", entityType: "Contact", entityId: "contact/42" }),
      "/permissions/entities/crm%2Fcontacts/Contact/contact%2F42/visibility",
    )
  })

  it("renders direct sharing without confusing it with ownership", () => {
    assert.deepEqual(
      visibilityPresentation({
        cube: "crm/contacts",
        entityType: "Contact",
        entityId: "contact-42",
        ownerId: "user-ana",
        createdBy: "user-ana",
        access: { source: "user-grant", name: "ana", actions: ["read", "edit"] },
        hidden: false,
        sharedWithCount: 0,
      }),
      {
        badges: ["PARTAJAT CU MINE", "OWNER: user-ana", "READ + EDIT"],
        visibilityAction: "hide",
      },
    )
  })

  it("offers unhide only for an entity hidden by the current user", () => {
    assert.deepEqual(
      visibilityPresentation({
        cube: "crm/contacts",
        entityType: "Contact",
        entityId: "contact-43",
        ownerId: "user-me",
        createdBy: "user-me",
        access: { source: "owner", name: "eu", actions: ["read", "edit", "delete", "share", "transfer"] },
        hidden: true,
        sharedWithCount: 2,
      }),
      {
        badges: ["A MEA", "CREATED BY ME", "SHARED: 2", "HIDDEN"],
        visibilityAction: "unhide",
      },
    )
  })

  it("labels creator provenance after ownership transfer without calling it a share", () => {
    assert.deepEqual(
      visibilityPresentation({
        cube: "crm/contracts",
        entityType: "Contract",
        entityId: "contract-1",
        ownerId: "new-owner",
        createdBy: "me",
        access: { source: "creator", name: "me", actions: ["read"] },
        hidden: false,
        sharedWithCount: 0,
      }).badges,
      ["CREATED BY ME", "OWNER: new-owner", "READ"],
    )
  })

  it("distinguishes administrative access from sharing", () => {
    assert.deepEqual(
      visibilityPresentation({
        cube: "crm/contracts",
        entityType: "Contract",
        entityId: "contract-2",
        ownerId: "ana",
        createdBy: "ana",
        access: { source: "cube-admin", name: "crm admin", actions: ["read", "edit"] },
        hidden: false,
        sharedWithCount: 0,
      }).badges,
      ["CUBE ADMIN", "OWNER: ana", "READ + EDIT"],
    )
  })
})
