// Echo A2 (read feed only) focused unit tests -- no database.
//
// The contracts under test, from the parent's corrections to the A2 brief:
//
//   1. `feedRowVisible` (cubes/echo/feed.ts): a row shows only when the target cube
//      CURRENTLY captures the row's entity type, the caller holds a REAL read-route
//      capability proven by mounted route metadata, and the target resolves through
//      `Registry.summary`. Admin gets NO bypass here -- admin's visibility comes from
//      grants on live cubes, modeled in the tests by giving admin the same gates.
//   2. `readRouteCap`: the route cap is read from MOUNTED route metadata, never invented;
//      a null-permission route (per-request gate) and a non-GET route prove nothing.
//   3. `visiblePage`: the cursor advances by the LAST SCANNED row, so pages of hidden rows
//      still move forward; an exhausted scan yields null.
//   4. The echo manifest itself passes `validateManifest`, and `readsActivity` stays
//      single-holder.

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { singleHolderOf } from "../../kernel/discovery.ts"
import type { ActivityRow, Manifest } from "../../kernel/manifest.ts"
import { InvalidManifestError, validateManifest } from "../../kernel/manifest-validation.ts"
import { commentEditSql, commentRemoveSql } from "../../pg/activity.ts"
import { commentAuthority, feedRowVisible, readRouteCap, visiblePage } from "./feed.ts"

const ADMIN_PERMISSIONS = ["echo:read", "notes:read", "account:read"]

const routes = (defs: Record<string, { method: string; permission: string | null }>) => defs

// The mounted route metadata the real `notes` cube publishes (its ROUTES contract).
const NOTES_ROUTES = routes({
  list: { method: "GET", permission: "notes:read" },
  get: { method: "GET", permission: "notes:read" },
  create: { method: "POST", permission: "notes:write" }, // not a read route
})

const meta = (over: Partial<{ capture: string | undefined; readCap: string | null }> = {}) => ({
  capture: "Note",
  readCap: "notes:read",
  ...over,
})

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  id: 1,
  at: "2026-09-07T00:00:00.000Z",
  cube: "notes",
  entityType: "Note",
  rowId: "n-1",
  op: "insert",
  version: null,
  actorId: null,
  actorUsername: null,
  changes: null,
  commentId: null,
  comment: null,
  ...over,
})

// --- 1. feedRowVisible: the four gates, each failing closed ---

describe("feedRowVisible", () => {
  it("a reader with entity read and the route cap sees the row", () => {
    assert.equal(feedRowVisible(meta(), row(), true), true)
  })

  it("entity read WITHOUT the route cap hides the row (denied route, granted entity)", () => {
    assert.equal(feedRowVisible(meta({ readCap: null }), row(), true), false)
  })

  it("route cap WITHOUT entity read hides the row (denied entity, granted route)", () => {
    assert.equal(feedRowVisible(meta(), row(), false), false)
  })

  it("revoking the route permission hides the row even though the summary is present", () => {
    // Revocation is modeled the way it happens: the caller's permission set loses the cap.
    const revoked = readRouteCap(NOTES_ROUTES, ["echo:read"])
    assert.equal(feedRowVisible({ capture: "Note", readCap: revoked }, row(), true), false)
  })

  it("a row whose entityType no longer matches the CURRENT capture entity is hidden", () => {
    assert.equal(feedRowVisible(meta({ capture: "Memo" }), row({ entityType: "Note" }), true), false)
  })

  it("an unknown or disabled cube (capture undefined) hides the row before any access", () => {
    assert.equal(feedRowVisible(meta({ capture: undefined }), row(), true), false)
  })

  it("the identity directory is hidden: it never captures, whatever a stale row claims", () => {
    assert.equal(
      feedRowVisible(
        meta({ capture: undefined, readCap: "account:read" }),
        row({ cube: "account", entityType: "Account" }),
        true,
      ),
      false,
    )
  })

  it("a deleted target (summary undefined) hides the row for readers AND admin", () => {
    assert.equal(feedRowVisible(meta(), row(), false), false)
    // Admin differs from the reader only in that the foundation answers its authorize calls;
    // a deleted row resolves to undefined either way, so the gate input is identical: false.
  })
})

// --- 2. readRouteCap: proven by mounted route metadata, never invented ---

describe("readRouteCap", () => {
  it("the canonical `get` route held returns its permission", () => {
    assert.equal(readRouteCap(NOTES_ROUTES, ADMIN_PERMISSIONS), "notes:read")
  })

  it("`get` absent falls back to `list`, the kernel's read convention", () => {
    assert.equal(
      readRouteCap(routes({ list: { method: "GET", permission: "notes:read" } }), ADMIN_PERMISSIONS),
      "notes:read",
    )
  })

  it("`get: null` is an explicit per-request opt-out, not a denial -- and proves nothing", () => {
    // Opt-out, not denial: the handler decides per request, and the feed cannot replay
    // a per-request decision from metadata, so it has no static proof and fails closed.
    assert.equal(
      readRouteCap(
        routes({ get: { method: "GET", permission: null }, list: { method: "GET", permission: "notes:read" } }),
        ADMIN_PERMISSIONS,
      ),
      null,
    )
  })

  it("an unrelated GET route with a held permission is NOT a read cap (the A2 finding)", () => {
    assert.equal(readRouteCap(routes({ export: { method: "GET", permission: "notes:read" } }), ADMIN_PERMISSIONS), null)
  })

  it("a `get` route with a non-GET method is not a read cap", () => {
    assert.equal(readRouteCap(routes({ get: { method: "POST", permission: "notes:read" } }), ADMIN_PERMISSIONS), null)
  })

  it("the `get` permission not in the caller's set fails closed", () => {
    assert.equal(readRouteCap(NOTES_ROUTES, ["echo:read"]), null)
  })

  it("no mounted route metadata at all fails closed", () => {
    assert.equal(readRouteCap(undefined, ADMIN_PERMISSIONS), null)
  })
})

// --- 3. visiblePage: cursor advances by the last SCANNED row ---

describe("visiblePage", () => {
  it("keeps only the visible rows", () => {
    const page = [row({ id: 10 }), row({ id: 9, rowId: "n-2" }), row({ id: 8, rowId: "n-3" })]
    const out = visiblePage(page, (r) => r.rowId !== "n-2")
    assert.deepEqual(
      out.rows.map((r) => r.id),
      [10, 8],
    )
  })

  it("a page where every row is hidden still advances the cursor to the last SCANNED id", () => {
    const page = [row({ id: 10 }), row({ id: 9 })]
    const out = visiblePage(page, () => false)
    assert.deepEqual(out.rows, [])
    assert.equal(out.nextBefore, 9)
  })

  it("an exhausted scan yields a null cursor", () => {
    assert.deepEqual(
      visiblePage([], () => true),
      { rows: [], nextBefore: null },
    )
  })

  it("the last visible row and the last scanned row differ correctly", () => {
    const page = [row({ id: 10 }), row({ id: 9 })]
    const out = visiblePage(page, (r) => r.id === 10)
    assert.equal(out.rows[0]!.id, 10)
    assert.equal(out.nextBefore, 9)
  })
})

// --- 4. manifest: echo mounts under the same rules as every cube ---

const echoManifest = {
  name: "echo",
  tables: [],
  requiresAuth: true,
  readsActivity: true,
  permissions: [{ name: "echo:read", roles: ["admin", "reader"] }],
  routes: { feed: "echo:read" },
} as unknown as Manifest

describe("echo manifest", () => {
  it("passes validateManifest under its own directory name", () => {
    assert.doesNotThrow(() => validateManifest("echo", echoManifest))
  })

  it("a lying name does not mount", () => {
    assert.throws(() => validateManifest("not-echo", echoManifest), InvalidManifestError)
  })

  it("readsActivity stays single-holder", () => {
    const other = { name: "sneak", tables: ["t"], readsActivity: true } as unknown as Manifest
    assert.throws(() => singleHolderOf([echoManifest, other], "readsActivity"))
  })
})

describe("comment authority and the pinned SQL (no database)", () => {
  it("commentAuthority: moderator wins, the author needs an editable target, anyone else is denied", () => {
    const c = { actorId: "ana" }
    assert.equal(commentAuthority(c, "bob", true, false), "moderator")
    assert.equal(commentAuthority(c, "ana", false, true), "owner")
    assert.equal(commentAuthority(c, "ana", false, false), "denied")
    assert.equal(commentAuthority(c, "bob", false, true), "denied")
    assert.equal(commentAuthority({ actorId: null }, "ana", false, true), "denied")
  })

  it("edit SQL always pins the actor; remove pins the actor unless moderating; both refuse deleted rows", () => {
    assert.ok(commentEditSql().includes("actor_id = $3"))
    assert.ok(commentEditSql().includes("deleted_at IS NULL"))
    assert.ok(commentRemoveSql(false).includes("actor_id = $3"))
    assert.ok(!commentRemoveSql(true).includes("actor_id"))
    assert.ok(commentRemoveSql(true).includes("deleted_at IS NULL"))
    assert.ok(commentRemoveSql(true).includes("body = ''"))
  })
})
