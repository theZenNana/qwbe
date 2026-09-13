// Echo A2 Slice 1: handler-level HTTP gate regression for the echo feed, in memory.
//
// Real parts, in process, no listener and no Postgres: real auth cube (login issues a token,
// `bearer` builds `CurrentUser`), real permissions cube, real notes cube (its own ROUTES and
// its real `summaryById`, which returns undefined for a deleted row), real `registryFrom`
// with `captureEntity` entries exactly as main.ts builds them, real `routeContracts`
// derivation for the catalogue (via `buildCatalogue`, as boot composes it), and the real
// `buildApi` + `buildHandlers` + `HttpApiBuilder.toWebHandler` stack. Only the store and the
// activity log are in memory.
//
// The walk proven here, per the owner's corrections to the A2 design: an admin-created note
// is NOT readable by another reader through the feed until an EXPLICIT entity grant exists
// (no implicit ownership sharing, no invented entity-DENY concept -- the permissions cube's
// grant API is the only entity mechanism exercised); a revoked grant closes the feed again;
// the target's route cap and the entity grant stay independent in BOTH directions (a caller
// holding the entity grant but not `notes:read` is still forbidden, and the unrelated-GET
// variant of that property is pinned at unit level in echo.test.ts -- no fixture cube is
// invented here for it); and a deleted target's history (Echo A3) opens ONLY to a superadmin
// or a cube-admin of the target, through the kernel row-state lookup (`RegistryEntry.state`,
// here the in-memory store's `byId`, which -- unlike pg's -- returns deleted rows, so it
// stands in for `rowStateFor` exactly), while readers stay hidden, comment writes stay
// refused, a missing target stays hidden even for admin, and a restored row is back on the
// ordinary live gates.
//
// The activity rows are pushed by the test right after each mutation, mirroring what
// pg/store.ts captures in the same transaction; the in-memory store cannot fire that path.

import assert from "node:assert/strict"
import { after, describe, it } from "node:test"
import { HttpApiBuilder, HttpServer } from "@effect/platform"
import { Effect, FiberRef, Layer } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import { buildCatalogue } from "../../catalogue.ts"
import { cube as authCube } from "../../cubes/auth/index.ts"
import { cube as notesCube } from "../../cubes/notes/index.ts"
import { cube as permissionsCube } from "../../cubes/permissions/index.ts"
import { captureEntity, enforceEntityHandlers } from "../../entity-enforcement.ts"
import { CurrentActor } from "../../kernel/actor.ts"
import type { MountedCube } from "../../kernel/discovery.ts"
import type { ActivityRow, ActivityTools, CommentRow } from "../../kernel/manifest.ts"
import type { RegistryEntry } from "../../kernel/registry.ts"
import { registryFrom } from "../../registry-runtime.ts"
import { buildApi, buildHandlers } from "../../runtime-composition.ts"
import { memoryStore } from "../../test-cube-tools.ts"
import { cube as echoCube } from "./index.ts"

// One world per process: `buildApi` widens the module-singleton groups IN PLACE, so only one
// composition may run. Everything below goes over this one router.
const rolesOf = new Map<string, ReadonlyArray<string>>()

export const world = () => {
  const store = memoryStore()

  // --- in-memory activity log, same predicate as pg/activity.ts ---
  const activityRows: Array<ActivityRow> = []
  let nextActivityId = 0
  const pushActivity = (op: string, rowId: string): ActivityRow => {
    const row: ActivityRow = {
      id: ++nextActivityId,
      at: new Date().toISOString(),
      cube: "notes",
      entityType: "Note",
      rowId,
      op,
      version: null,
      actorId: null,
      actorUsername: null,
      changes: null,
      commentId: null,
      comment: null,
    }
    activityRows.push(row)
    return row
  }
  // Same filters as pg/activity.ts: cube, entityType, entityId, beforeId; ORDER BY id DESC LIMIT.
  // The comment store below mirrors pg semantics: add reads the CurrentActor FiberRef (the
  // handler wrapper's attribution), edit always pins the actor's own row, the moderator flag
  // decides the WHERE clause for remove only, deletion wipes the body in place. Comment rows
  // are never hard-deleted.
  const commentRows: Array<CommentRow> = []
  const matches = (
    c: CommentRow,
    id: string,
    moderator: boolean,
    actor: { readonly id: string } | undefined,
  ): boolean => c.id === id && c.deletedAt === null && (moderator || (actor !== undefined && c.actorId === actor.id))
  const comments = {
    add: (target: { readonly cube: string; readonly entityType: string; readonly entityId: string }, body: string) =>
      Effect.gen(function* () {
        const actor = yield* FiberRef.get(CurrentActor)
        const c: CommentRow = {
          id: crypto.randomUUID(),
          cube: target.cube,
          entityType: target.entityType,
          rowId: target.entityId,
          actorId: actor?.id ?? null,
          actorUsername: actor?.username ?? null,
          body,
          createdAt: new Date().toISOString(),
          editedAt: null,
          deletedAt: null,
          deletedBy: null,
        }
        commentRows.push(c)
        // The linked event, same transaction in pg -- one push here. The row carries the
        // comment joined, exactly what the page LEFT JOIN returns.
        const row: ActivityRow = {
          id: ++nextActivityId,
          at: new Date().toISOString(),
          cube: target.cube,
          entityType: target.entityType,
          rowId: target.entityId,
          op: "comment",
          version: null,
          actorId: actor?.id ?? null,
          actorUsername: actor?.username ?? null,
          changes: {},
          commentId: c.id,
          comment: c,
        }
        activityRows.push(row)
        return row
      }),
    byId: (id: string) => Effect.succeed(commentRows.find((c) => c.id === id)),
    // No moderator form, same as pg: the row must be the current actor's own.
    edit: (id: string, body: string) =>
      Effect.gen(function* () {
        const actor = yield* FiberRef.get(CurrentActor)
        const c = commentRows.find((row) => matches(row, id, false, actor))
        if (!c) return undefined
        const updated: CommentRow = { ...c, body, editedAt: new Date().toISOString() }
        commentRows[commentRows.indexOf(c)] = updated
        return updated
      }),
    remove: (id: string, moderator: boolean) =>
      Effect.gen(function* () {
        const actor = yield* FiberRef.get(CurrentActor)
        const c = commentRows.find((row) => matches(row, id, moderator, actor))
        if (!c) return undefined
        // The in-place wipe: body gone, markers set, the linked activity row stays.
        const updated: CommentRow = {
          ...c,
          body: "",
          deletedAt: new Date().toISOString(),
          deletedBy: actor?.id ?? null,
        }
        commentRows[commentRows.indexOf(c)] = updated
        return updated
      }),
  }
  const activity: ActivityTools = {
    page: (query) =>
      Effect.succeed(
        activityRows
          .filter(
            (row) =>
              (query.cube === undefined || row.cube === query.cube) &&
              (query.entityType === undefined || row.entityType === query.entityType) &&
              (query.entityId === undefined || row.rowId === query.entityId) &&
              (query.beforeId === undefined || row.id < query.beforeId),
          )
          .slice(-Math.min(Math.max(1, query.limit), 50))
          .reverse()
          .map((row) =>
            row.commentId ? { ...row, comment: commentRows.find((c) => c.id === row.commentId) ?? null } : row,
          ),
      ),
    comments,
  }

  // --- permissions: declared map from the real manifests, service from the real cube ---
  const declared = new Map<string, ReadonlyArray<string>>(
    [authCube, permissionsCube, notesCube, echoCube].flatMap((c) =>
      (c.manifest.permissions ?? []).map((p) => [p.name, p.roles as ReadonlyArray<string>] as const),
    ),
  )
  const permissionsParts = permissionsCube.create({
    store,
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    identities: { resolveUsername: (username) => Effect.succeed({ id: username, username }) },
  })
  const service = permissionsParts.entityPermissions
  assert.ok(service)

  // --- real notes cube, real handlers (its `get`/`summaryById` gate per request) ---
  const notesParts = notesCube.create({
    store,
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    entityPermissions: service,
  })

  // --- real auth cube; the password is not checked, accounts are whatever `rolesOf` says ---
  const auth = authCube.create({
    store: memoryStore(),
    bus: { publish: () => Effect.void },
    catalogue: () => [],
    permissions: () => declared,
    commands: () => [],
    credentials: {
      verify: (username) => Effect.succeed({ id: username, username, roles: rolesOf.get(username) ?? [] }),
    },
    entityPermissions: service,
  })
  assert.ok(auth.layers)

  // --- real catalogue: route contracts derived by the real routeContracts path, as boot does.
  // Echo itself holds no entity rows and its own routes are never a feed TARGET, so the
  // derivation covers the three cubes with contracts that matter here. ---
  const definitions = [
    { name: "auth", manifest: authCube.manifest, parts: auth },
    { name: "permissions", manifest: permissionsCube.manifest, parts: permissionsParts },
    { name: "notes", manifest: notesCube.manifest, parts: notesParts },
  ].map(({ name, manifest, parts }) => ({
    name,
    plugin: null,
    manifest,
    cube: { name, parts: { group: (parts as unknown as { group: unknown }).group } },
  }))
  const catalogue = buildCatalogue(
    definitions,
    () => true,
    () => undefined,
    [],
  )

  // --- echo cube over the in-memory activity tool; the comment routes gate through the REAL
  // entity permission service, so echo receives it exactly as discovery hands it out. ---
  const echoParts = echoCube.create({
    store,
    activity,
    catalogue: () => catalogue,
    entityPermissions: service,
  } as unknown as CubeTools)

  // --- registry exactly as main.ts builds it: real summary via the entity permissions gate.
  // The account directory is not mounted here, so its ONE registry read (auth's session
  // validation: summary("Account", id)) is answered by a minimal entry through the SAME
  // registryFrom -- roles read live from `rolesOf`, exactly what the real account cube
  // publishes in its summary. ---
  const accountEntry: RegistryEntry = {
    name: "account",
    entity: "Account",
    permissionExempt: true,
    relational: {
      summaryById: (id) =>
        Effect.succeed({ id, title: id, details: [{ key: "roles", value: (rolesOf.get(id) ?? []).join(",") }] }),
    },
  }
  // Typed RegistryEntry[] built exactly as main.ts builds the mounted entries: only the notes
  // cube has a real relational part here (auth and permissions mount no entity directory, echo
  // holds no entity rows), so the Account summary auth needs at login is answered by the
  // clean account entry below, through the SAME registryFrom and the real permission service.
  const entries: RegistryEntry[] = [
    {
      name: "auth",
      entity: authCube.manifest.entity,
      permissionExempt: authCube.manifest.providesIdentityDirectory === true,
      captureEntity: captureEntity(authCube.manifest),
    },
    {
      name: "permissions",
      entity: permissionsCube.manifest.entity,
      permissionExempt: permissionsCube.manifest.providesIdentityDirectory === true,
      captureEntity: captureEntity(permissionsCube.manifest),
    },
    {
      name: "notes",
      entity: notesCube.manifest.entity,
      relational: notesParts.relational,
      permissionExempt: notesCube.manifest.providesIdentityDirectory === true,
      captureEntity: captureEntity(notesCube.manifest),
      // The kernel row-state seam, as main.ts wires `rowStateFor`: metadata only, no body.
      state: (id) =>
        Effect.map(store.byId<{ id: string; type: string; deleted: boolean }>("notes", id), (row) =>
          row ? { id: row.id, type: row.type, deleted: row.deleted === true } : undefined,
        ),
    },
    {
      name: "echo",
      entity: echoCube.manifest.entity,
      permissionExempt: echoCube.manifest.providesIdentityDirectory === true,
      captureEntity: captureEntity(echoCube.manifest),
    },
    accountEntry,
  ]
  const RegistryLive = registryFrom(
    entries,
    () => [],
    () => true,
    service,
  )
  const authLive = Layer.provide(auth.layers, RegistryLive)

  const cubes = [
    { manifest: authCube.manifest, name: "auth", parts: auth, plugin: null, commands: [] },
    { manifest: permissionsCube.manifest, name: "permissions", parts: permissionsParts, plugin: null, commands: [] },
    {
      manifest: notesCube.manifest,
      name: "notes",
      // The generic entity gate, as `mediateEntityCube` applies it at boot (capability-runtime.ts).
      parts: {
        group: notesParts.group,
        handlers: enforceEntityHandlers("notes", "Note", notesParts.group as never, notesParts.handlers, service),
      },
      plugin: null,
      commands: [],
    },
    {
      manifest: echoCube.manifest,
      name: "echo",
      parts: { group: echoParts.group, handlers: echoParts.handlers },
      plugin: null,
      commands: [],
    },
  ] as unknown as ReadonlyArray<MountedCube>

  const api = buildApi(cubes)
  const ApiLive = HttpApiBuilder.api(api).pipe(
    Layer.provide(buildHandlers(api, cubes).pipe(Layer.provide(RegistryLive))),
    Layer.provide(authLive),
  )
  const web = HttpApiBuilder.toWebHandler(Layer.mergeAll(ApiLive, HttpServer.layerContext))

  const http = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await web.handler(
      new Request(`http://qwbe.test${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    )
    const text = await response.text()
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null }
  }
  const token = async (userId: string, roles: ReadonlyArray<string>) => {
    rolesOf.set(userId, roles)
    const login = await http("POST", "/auth/login", undefined, { username: userId, password: "" })
    assert.equal(login.status, 200)
    return (login.body as { token: string }).token
  }
  return { store, pushActivity, http, token, RegistryLive, service, echoParts, dispose: () => web.dispose() }
}

// One world for the whole file (see the note above `world`); the two walks below use
// separate notes and separate grants, so neither sees the other's rows.
const w = world()
const rowsOf = (response: { body: Record<string, unknown> | null }) =>
  (response.body?.rows ?? []) as Array<{ id: number; op: string }>
const needed = (response: { status: number; body: Record<string, unknown> | null }) => {
  assert.equal(response.status, 403, JSON.stringify(response.body))
  return response.body?.needed
}

describe("echo feed over the real router (Echo A2 slice 1)", () => {
  after(() => w.dispose())

  it("owner creates, other is forbidden until an explicit grant, grant, revoke, route independence, deleted history for moderators only", async () => {
    // 1. The owner (admin) creates a private note. The test pushes the activity row itself,
    //    mirroring what pg/store.ts captures in the same transaction.
    const owner = await w.token("ovidiu", ["admin"])
    const created = await w.http("POST", "/notes", owner, { title: "Private", body: "secret" })
    assert.equal(created.status, 200)
    const id = created.body?.id as string
    assert.ok(id)
    const insertRow = w.pushActivity("insert", id)
    assert.equal(insertRow.op, "insert")

    // 2. The feed is the target route: the reader holds echo:read and notes:read by manifest
    //    defaults, but the note is private -- no entity grant, no visibility.
    const reader = await w.token("ana", ["reader"])
    const feed = (token: string) => w.http("GET", `/echo/feed?cube=notes&entityId=${id}`, token)
    assert.equal(await needed(await feed(reader)), "echo:read")
    // The notes GET route itself agrees: the reader cannot read the note either.
    assert.equal(await needed(await w.http("GET", `/notes/${id}`, reader)), "notes:entity")

    // 3. An explicit READ grant opens the feed: rows length 1, the insert row.
    const grant = await w.http("POST", `/permissions/entities/notes/Note/${id}/grants/user`, owner, {
      username: "ana",
      actions: ["read"],
    })
    assert.equal(grant.status, 200)
    const granted = await feed(reader)
    assert.equal(granted.status, 200)
    assert.equal((granted.body?.rows as unknown[] | undefined)?.length, 1)

    // 4. Revoking the grant closes the feed again.
    const revoke = await w.http("DELETE", `/permissions/grants/${grant.body?.id}`, owner)
    assert.equal(revoke.status, 200)
    assert.equal(await needed(await feed(reader)), "echo:read")

    // 5. Route cap and entity grant stay independent: an entity grant WITHOUT notes:read is
    //    still forbidden. (The unrelated-GET-route variant of the route cap is pinned at
    //    unit level in echo.test.ts; no fixture cube is invented here for it.)
    await w.http("POST", `/permissions/entities/notes/Note/${id}/grants/user`, owner, {
      username: "eve",
      actions: ["read"],
    })
    await w.http("POST", "/permissions/capabilities/user", owner, { capability: "echo:read", username: "eve" })
    const eve = await w.token("eve", [])
    assert.equal(await needed(await feed(eve)), "echo:read")

    // 6. A deleted target (Echo A3). The soft delete and its activity row mirror pg/store.ts:
    //    `deleted = true` plus one `op = "delete"` row, same transaction. The reader -- even
    //    re-granted read on the row -- stays hidden; the superadmin sees the whole history.
    await Effect.runPromise(w.store.update("notes", id, { deleted: true }))
    const deleteRow = w.pushActivity("delete", id)
    const regrant = await w.http("POST", `/permissions/entities/notes/Note/${id}/grants/user`, owner, {
      username: "ana",
      actions: ["read"],
    })
    assert.equal(regrant.status, 200)
    assert.equal(await needed(await feed(reader)), "echo:read")
    const history = await feed(owner)
    assert.equal(history.status, 200, JSON.stringify(history.body))
    assert.deepEqual(
      rowsOf(history).map((r) => [r.id, r.op]),
      [
        [deleteRow.id, "delete"],
        [insertRow.id, "insert"],
      ],
    )

    // 7. A cube-admin of notes (no admin role, decision source "cube-admin") sees it too;
    //    the same account as a plain reader of another cube would not.
    assert.equal(
      (await w.http("POST", "/permissions/cube-admins", owner, { cube: "notes", username: "cara" })).status,
      200,
    )
    const cara = await w.token("cara", ["reader"])
    const caraHistory = await feed(cara)
    assert.equal(caraHistory.status, 200, JSON.stringify(caraHistory.body))
    assert.equal(rowsOf(caraHistory).length, 2)

    // 8. General feed after the delete: hidden for the reader, present for the moderators,
    //    and the cursor still advances past the scanned rows for everyone. The scan is
    //    newest-first (ORDER BY id DESC), so the LAST scanned row is the oldest: the insert.
    const general = (token: string) => w.http("GET", "/echo/feed?cube=notes", token)
    const readerPage = await general(reader)
    assert.equal(readerPage.status, 200)
    assert.deepEqual(readerPage.body?.rows, [])
    assert.equal(readerPage.body?.nextBefore, insertRow.id)
    const adminPage = await general(owner)
    assert.deepEqual(
      rowsOf(adminPage).map((r) => r.id),
      [deleteRow.id, insertRow.id],
    )
    assert.equal(adminPage.body?.nextBefore, insertRow.id)
    assert.equal(rowsOf(await general(cara)).length, 2)

    // 9. A target the owning store does not hold at all stays hidden from everyone, admin
    //    included: "missing" is never read as "deleted", and the activity log is not asked.
    w.pushActivity("delete", "note-never-existed")
    assert.equal(
      await needed(await w.http("GET", "/echo/feed?cube=notes&entityId=note-never-existed", owner)),
      "echo:read",
    )
    assert.equal(
      await needed(await w.http("GET", "/echo/feed?cube=notes&entityId=note-never-existed", cara)),
      "echo:read",
    )
    assert.ok(!JSON.stringify((await general(owner)).body).includes("note-never-existed"))

    // 10. Restored: the row is live again, so the ordinary gates apply -- the re-granted
    //     reader sees it, the admin still does, and eve (entity grant, no notes:read) does not.
    await Effect.runPromise(w.store.update("notes", id, { deleted: false }))
    w.pushActivity("update", id)
    const restored = await feed(reader)
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(rowsOf(restored).length, 3)
    assert.equal((await feed(owner)).status, 200)
    assert.equal(await needed(await feed(eve)), "echo:read")
  })

  it("comments: read-only grantee and stranger refused, EDIT grantee posts, only the author edits, revoke revokes, moderator deletes, deleted and deleted-target refuse, body boundary", async () => {
    const owner = await w.token("ovidiu", ["admin"])
    const ana = await w.token("ana", ["reader"])
    const bob = await w.token("bob", ["reader"])
    const eve = await w.token("eve", [])
    const created = await w.http("POST", "/notes", owner, { title: "Shared", body: "text" })
    assert.equal(created.status, 200)
    const id = created.body?.id as string
    w.pushActivity("insert", id)
    const target = `?cube=notes&entityId=${id}`
    const grant = (username: string, actions: ReadonlyArray<string>) =>
      w.http("POST", `/permissions/entities/notes/Note/${id}/grants/user`, owner, { username, actions })
    const post = (token: string | undefined, body: unknown) => w.http("POST", `/echo/comments${target}`, token, body)
    const patch = (token: string, cid: string, body: string) =>
      w.http("PATCH", `/echo/comments/${cid}`, token, { body })
    const del = (token: string, cid: string) => w.http("DELETE", `/echo/comments/${cid}`, token)
    const feed = (token: string) => w.http("GET", `/echo/feed${target}`, token)

    // 1. Read-only grantee, stranger, anonymous: all refused.
    const readGrant = await grant("ana", ["read"])
    assert.equal(readGrant.status, 200)
    assert.equal(await needed(await post(ana, { body: "hi" })), "echo:write")
    assert.equal(await needed(await post(eve, { body: "hi" })), "echo:write")
    const anonymous = await post(undefined, { body: "hi" })
    assert.ok(anonymous.status === 401 || anonymous.status === 403, String(anonymous.status))

    // 2. EDIT grant: the post lands as op "comment", attributed to ana, and the returned row
    //    matches what the feed then returns (B5: the comment travels with the row).
    let editGrant = await grant("ana", ["read", "edit"])
    assert.equal(editGrant.status, 200)
    const first = "  first words  "
    const posted = await post(ana, { body: first })
    assert.equal(posted.status, 200, JSON.stringify(posted.body))
    assert.equal(posted.body?.op, "comment")
    assert.equal(posted.body?.actorId, "ana")
    const cid = posted.body?.commentId as string
    assert.ok(cid)
    const postedComment = posted.body?.comment as Record<string, unknown>
    assert.equal(postedComment.id, cid)
    // B4: the boundary TRIMS; the stored body is the trimmed text.
    assert.equal(postedComment.body, "first words")
    const feed1 = await feed(ana)
    assert.equal(feed1.status, 200)
    const rows1 = feed1.body?.rows as Array<Record<string, unknown>>
    const row1 = rows1.find((r) => r.commentId === cid)
    assert.ok(row1)
    assert.deepEqual(row1.comment, postedComment)

    // 3. Another EDIT grantee is not the author: no edit, no delete.
    assert.equal((await grant("bob", ["read", "edit"])).status, 200)
    assert.equal(await needed(await patch(bob, cid, "mine now")), "echo:write")
    assert.equal(await needed(await del(bob, cid)), "echo:write")

    // 4. The author edits; the old body is gone from the feed entirely.
    const edited = await patch(ana, cid, "second words")
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(edited.body?.body, "second words")
    assert.notEqual(edited.body?.editedAt, null)
    const feed2 = await feed(ana)
    const text2 = JSON.stringify(feed2.body)
    assert.ok(text2.includes("second words"))
    assert.ok(!text2.includes("first words"))

    // 5. Revoking the target grant revokes comment authority; a re-grant restores it.
    assert.equal((await w.http("DELETE", `/permissions/grants/${editGrant.body?.id}`, owner)).status, 200)
    assert.equal((await w.http("DELETE", `/permissions/grants/${readGrant.body?.id}`, owner)).status, 200)
    //    The target gate is the feed gate, so the refusal names echo:read, as the feed does.
    assert.equal(await needed(await patch(ana, cid, "revoked")), "echo:read")
    assert.equal(await needed(await del(ana, cid)), "echo:read")
    editGrant = await grant("ana", ["read", "edit"])
    assert.equal(editGrant.status, 200)

    // 6. Superadmin: never edits another's words; deletes as moderator (source "superadmin").
    assert.equal(await needed(await patch(owner, cid, "admin words")), "echo:write")
    const removed = await del(owner, cid)
    assert.equal(removed.status, 200, JSON.stringify(removed.body))
    assert.equal(removed.body?.body, "")
    assert.notEqual(removed.body?.deletedAt, null)
    assert.equal(removed.body?.deletedBy, "ovidiu")
    const feed3 = await feed(ana)
    const rows3 = feed3.body?.rows as Array<Record<string, unknown>>
    const row3 = rows3.find((r) => r.commentId === cid)
    assert.ok(row3)
    const comment3 = row3.comment as Record<string, unknown>
    assert.equal(comment3.body, "")
    assert.notEqual(comment3.deletedAt, null)
    assert.ok(!JSON.stringify(feed3.body).includes("second words"))

    // 7. A deleted comment is gone for everyone; an unknown id is the same 403.
    assert.equal(await needed(await patch(ana, cid, "again")), "echo:write")
    assert.equal(await needed(await del(ana, cid)), "echo:write")
    assert.equal(await needed(await del(owner, cid)), "echo:write")
    assert.equal(await needed(await del(owner, "no-such-comment")), "echo:write")

    // 8. Body boundary: whitespace-only and over-cap bodies are 400 at the schema.
    assert.equal((await post(ana, { body: "   " })).status, 400)
    assert.equal((await post(ana, { body: "x".repeat(4001) })).status, 400)
    assert.equal((await post(ana, { body: "x".repeat(4000) })).status, 200)

    // 9. A deleted target refuses every comment write, author and admin alike.
    await Effect.runPromise(w.store.update("notes", id, { deleted: true }))
    w.pushActivity("delete", id)
    assert.equal(await needed(await post(ana, { body: "late" })), "echo:read")
    assert.equal(await needed(await post(owner, { body: "late" })), "echo:read")
  })

  it("feed query bounds: before/limit must be finite safe positive integers, else 400 at the schema", async () => {
    const owner = await w.token("ovidiu", ["admin"])
    const general = (params: string) => w.http("GET", `/echo/feed?cube=notes${params}`, owner)
    // NumberFromString decodes every one of these to a number (NaN, +/-Infinity, a fraction,
    // an unsafe integer, zero, a negative); pg would reject them as bigint / LIMIT. The
    // schema refuses them before any store call, on both parameters.
    for (const bad of ["NaN", "Infinity", "-Infinity", "1.5", "1e400", "1e20", "0", "-1", "abc", ""]) {
      assert.equal((await general(`&before=${bad}`)).status, 400, `before=${bad}`)
      assert.equal((await general(`&limit=${bad}`)).status, 400, `limit=${bad}`)
    }
    // A valid page keeps its behaviour: limit caps the rows, before excludes newer ids.
    const all = await general("")
    assert.equal(all.status, 200)
    const ids = rowsOf(all).map((r) => r.id)
    assert.ok(ids.length >= 2)
    const one = await general("&limit=1")
    assert.equal(one.status, 200)
    assert.deepEqual(
      rowsOf(one).map((r) => r.id),
      [ids[0]],
    )
    const older = await general(`&before=${ids[0]}&limit=1e3`)
    assert.equal(older.status, 200)
    assert.deepEqual(
      rowsOf(older).map((r) => r.id),
      ids.slice(1),
    )
  })
})
