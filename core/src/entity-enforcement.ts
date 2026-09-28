import { Effect } from "effect"
import {
  actorFrom,
  containsStatus,
  type EndpointGroup,
  EntityPermissionContractError,
  type Handler,
  isRecord,
  itemId,
  schemaFields,
} from "./entity-contract.ts"
import { CurrentUser } from "./kernel/auth-contract.ts"
import { Forbidden } from "./kernel/errors.ts"
import { listPageRequest } from "./kernel/list.ts"
import type { AccessDecision, EntityRef, PermissionActor } from "./permissions-contracts.ts"
import type { ListScope, ListSource } from "./permissions-service.ts"

export { EntityPermissionContractError }

type Gate = Readonly<{
  authorize: (
    actor: PermissionActor,
    ref: EntityRef,
    action: "read" | "edit" | "delete",
  ) => Effect.Effect<AccessDecision, unknown>
  authorizeList: (
    actor: PermissionActor,
    scope: ListScope,
    action: "read",
  ) => Effect.Effect<"all" | ReadonlySet<string>, unknown>
  auditList: (
    actor: PermissionActor,
    scope: ListScope,
    action: "read",
    source: ListSource,
    returnedIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, unknown>
  claim: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<unknown, unknown>
  ownership: (ref: EntityRef) => Effect.Effect<unknown>
}>

const deny = (cube: string) =>
  new Forbidden({ message: "this entity is not shared with you", needed: [cube, "entity"].join(":") })

const runHandler = (handler: Handler, request: unknown) => handler(request)

/**
 * The ONE predicate deciding both which cubes get entity mediation and which get activity
 * capture. Exported so `discovery.ts` (the store's capture entity) and `mediateEntityCube`
 * (the wrapper) read the same rule from the same place: the recorded set and the mediated set
 * cannot drift. The identity directory is excluded -- it holds credentials, and its rows are
 * never business-activity material.
 */
export const recordsActivity = <M extends { entity?: string; providesIdentityDirectory?: boolean }>(
  manifest: M,
): manifest is M & { entity: string } => Boolean(manifest.entity) && !manifest.providesIdentityDirectory

/**
 * Echo A1: the DECLARED ENTITY TYPE whose rows are captured -- not a boolean. Only rows whose
 * type is exactly this string are recorded (pg/store.ts), so a cube's auxiliary tables are
 * never captured. Undefined for non-entity cubes and the identity directory.
 */
export const captureEntity = <M extends { entity?: string; providesIdentityDirectory?: boolean }>(
  manifest: M,
): string | undefined => (recordsActivity(manifest) ? manifest.entity : undefined)

/**
 * Kernel-owned mediation for entity routes. A plugin receives no choice about this wrapper:
 * discovery applies it from the manifest's concrete `entity`, after `create` returns handlers.
 */
export const enforceEntityHandlers = <Handlers extends Readonly<Record<string, unknown>>>(
  cube: string,
  entityType: string,
  group: EndpointGroup,
  handlers: Handlers,
  permissions: Gate,
): Handlers => {
  const protectedHandlers: Record<string, unknown> = { ...handlers }
  for (const endpoint of Object.values(group.endpoints)) {
    const candidate = handlers[endpoint.name]
    if (typeof candidate !== "function") continue
    const handler = candidate as Handler
    const parameters = schemaFields(endpoint.pathSchema)
    if (!containsStatus(endpoint.errorSchema, 403)) throw new EntityPermissionContractError(cube, endpoint.name)

    if (parameters.length > 0) {
      if (parameters.length !== 1) throw new EntityPermissionContractError(cube, endpoint.name)
      const action = endpoint.method === "GET" ? "read" : endpoint.method === "DELETE" ? "delete" : "edit"
      protectedHandlers[endpoint.name] = (request: unknown) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const id = itemId(request, parameters[0]!)
          if (!id) return yield* Effect.fail(deny(cube))
          const decision = yield* permissions.authorize(actorFrom(user), { cube, entityType, entityId: id }, action)
          if (!decision.allowed) return yield* Effect.fail(deny(cube))
          return yield* runHandler(handler, request)
        })
      continue
    }

    if (endpoint.method === "POST") {
      protectedHandlers[endpoint.name] = (request: unknown) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const result = yield* runHandler(handler, request)
          if (!isRecord(result) || typeof result.id !== "string") {
            return yield* Effect.die(new Error([cube, endpoint.name, "did not return an entity id"].join(" ")))
          }
          const ref = { cube, entityType, entityId: result.id }
          if (!(yield* permissions.ownership(ref))) yield* permissions.claim(actorFrom(user), ref).pipe(Effect.orDie)
          return result
        })
      continue
    }

    if (endpoint.method === "GET") {
      const pageFields = new Set(schemaFields(endpoint.successSchema))
      if (!["rows", "total", "offset", "limit", "sortedBy"].every((field) => pageFields.has(field))) {
        throw new EntityPermissionContractError(cube, endpoint.name)
      }
      // One `authorizeList`, one handler call for exactly the asked page, one `entity.list` audit
      // row (Qwbe#73). The handler filters by the injected `ids` in SQL; the wrapper checks it did.
      protectedHandlers[endpoint.name] = (request: unknown) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          if (!isRecord(request) || !isRecord(request.urlParams))
            return yield* Effect.die("entity list needs paging params")
          const actor = actorFrom(user)
          const scope = { cube, entityType }
          const visible = yield* permissions.authorizeList(actor, scope, "read").pipe(Effect.orDie)
          let urlParams = request.urlParams
          if (visible !== "all") {
            // The SAME reading of the query the generic list handler does, taken BEFORE `ids` is
            // injected: an `ids` batch without a size sets the page size, and the injected set
            // must not. The caller's own `ids` narrow the set; every other filter stays.
            const asked = listPageRequest(request.urlParams)
            const wanted = typeof urlParams.ids === "string" ? urlParams.ids.split(",").map((s) => s.trim()) : undefined
            const ids = wanted ? wanted.filter((id) => visible.has(id)) : [...visible]
            // Empty `ids` means "no filter" to the store, so an actor who sees nothing never reaches it.
            if (ids.length === 0) {
              yield* permissions.auditList(actor, scope, "read", "scoped", []).pipe(Effect.orDie)
              return {
                rows: [],
                total: 0,
                offset: asked.offset,
                limit: asked.limit,
                sortedBy: asked.sortBy ?? "createdAt",
              }
            }
            // `page` and `pageSize` are dropped, not overridden: the explicit offset/limit win.
            urlParams = {
              ...urlParams,
              ids: ids.join(","),
              page: undefined,
              pageSize: undefined,
              offset: asked.offset,
              limit: asked.limit,
            }
          }
          const result = yield* runHandler(handler, { ...request, urlParams })
          if (!isRecord(result) || !Array.isArray(result.rows) || typeof result.total !== "number") {
            return yield* Effect.die("entity list violated its PageOf contract")
          }
          const returned: Array<string> = []
          for (const row of result.rows as ReadonlyArray<unknown>) {
            if (!isRecord(row) || typeof row.id !== "string" || (visible !== "all" && !visible.has(row.id))) {
              return yield* Effect.die(
                new Error([cube, endpoint.name, "returned a row outside the visible ids"].join(" ")),
              )
            }
            returned.push(row.id)
          }
          const source: ListSource =
            visible !== "all" ? "scoped" : user.roles.includes("admin") ? "superadmin" : "cube-admin"
          yield* permissions.auditList(actor, scope, "read", source, returned).pipe(Effect.orDie)
          return result
        })
    }
  }
  return protectedHandlers as Handlers
}

export const mediateEntityCube = <
  Parts extends Readonly<{ group: unknown; handlers: Readonly<Record<string, unknown>> }>,
>(
  cube: string,
  manifest: Readonly<{ entity?: string; providesIdentityDirectory?: boolean }>,
  parts: Parts,
  permissions: Gate,
): Parts =>
  recordsActivity(manifest)
    ? {
        ...parts,
        handlers: enforceEntityHandlers(
          cube,
          manifest.entity,
          parts.group as EndpointGroup,
          parts.handlers,
          permissions,
        ),
      }
    : parts
