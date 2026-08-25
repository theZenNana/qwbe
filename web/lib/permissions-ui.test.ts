import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  canManageGrants,
  grantActionOptions,
  grantLabel,
  grantsListPath,
  permissionsListPath,
  revokeGrantPath,
  visibilityMutationPath,
  visibilityOptions,
  visibilityPresentation,
} from "./permissions-ui.ts"

describe("permissions list UI contract", () => {
  it("offers the complete typed custom-action vocabulary", () => {
    assert.deepEqual(grantActionOptions, ["read", "create", "edit", "delete", "share", "transfer"])
  })

  it("does not show grant management to a TOTAL grantee", () => {
    assert.equal(canManageGrants("user-grant"), false)
    assert.equal(canManageGrants("group-grant"), false)
    assert.equal(canManageGrants("owner"), true)
    assert.equal(canManageGrants("cube-admin"), true)
    assert.equal(canManageGrants("superadmin"), true)
  })

  it("targets grant list and revoke routes with escaped identities", () => {
    const ref = { cube: "crm/contacts", entityType: "Contact", entityId: "contact/42" }
    assert.equal(
      grantsListPath(ref, 10, 5),
      "/permissions/entities/crm%2Fcontacts/Contact/contact%2F42/grants?offset=10&limit=5",
    )
    assert.equal(revokeGrantPath("grant/7"), "/permissions/grants/grant%2F7")
  })

  it("shows who receives which custom grant", () => {
    assert.equal(
      grantLabel({
        id: "grant-1",
        cube: "notes",
        entityType: "Note",
        entityId: "note-1",
        subject: { kind: "group", groupId: "sales" },
        actions: ["read", "edit"],
        createdBy: "ana",
        createdAt: "2026-08-15T00:00:00Z",
      }),
      "GROUP sales - READ + EDIT",
    )
  })

  it("sends provenance and hidden filters to the server", () => {
    assert.equal(
      permissionsListPath("crm/contacts", { view: "shared-with-me", offset: 20, limit: 10 }),
      "/permissions/entities/crm%2Fcontacts?view=shared-with-me&sortBy=createdAt&descending=true&offset=20&limit=10",
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
        createdAt: "2026-08-15T00:00:00Z",
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
        createdAt: "2026-08-15T00:00:00Z",
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
        createdAt: "2026-08-15T00:00:00Z",
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
        createdAt: "2026-08-15T00:00:00Z",
        access: { source: "cube-admin", name: "crm admin", actions: ["read", "edit"] },
        hidden: false,
        sharedWithCount: 0,
      }).badges,
      ["CUBE ADMIN", "OWNER: ana", "READ + EDIT"],
    )
  })
})
