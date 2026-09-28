import { Effect } from "effect"
import {
  actorFrom,
  containsStatus,
  type Endpoint,
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
import type { PageRequest } from "./kernel/pagination.ts"
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

type Visible = "all" | ReadonlySet<string>
type ListRequest = Readonly<{ urlParams: Readonly<Record<string, unknown>> }>

const isListRequest = (request: unknown): request is ListRequest => isRecord(request) && isRecord(request.urlParams)

const actionOf = (method: string) => (method === "GET" ? "read" : method === "DELETE" ? "delete" : "edit")

/** Item routes: the one path id is authorized before the plugin handler runs. */
const guardItem =
  (
    scope: ListScope,
    parameter: string,
    action: "read" | "edit" | "delete",
    handler: Handler,
    gate: Pick<Gate, "authorize">,
  ) =>
  (request: unknown) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const id = itemId(request, parameter)
      if (!id) return yield* Effect.fail(deny(scope.cube))
      const decision = yield* gate.authorize(actorFrom(user), { ...scope, entityId: id }, action)
      if (!decision.allowed) return yield* Effect.fail(deny(scope.cube))
      return yield* runHandler(handler, request)
    })

/** Create routes: the new row is claimed for the actor unless it already has an owner. */
const claimCreated =
  (scope: ListScope, label: string, handler: Handler, gate: Pick<Gate, "claim" | "ownership">) => (request: unknown) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const result = yield* runHandler(handler, request)
      if (!isRecord(result) || typeof result.id !== "string") {
        return yield* Effect.die(new Error([label, "did not return an entity id"].join(" ")))
      }
      const ref = { ...scope, entityId: result.id }
      if (!(yield* gate.ownership(ref))) yield* gate.claim(actorFrom(user), ref).pipe(Effect.orDie)
      return result
    })

/** The ids to inject: the caller's own `ids` narrowed to `visible`, else all of `visible`. */
const narrowIds = (asked: unknown, visible: ReadonlySet<string>) =>
  typeof asked === "string"
    ? asked
        .split(",")
        .map((s) => s.trim())
        .filter((id) => visible.has(id))
    : [...visible]

const emptyPage = (asked: PageRequest) => ({
  rows: [],
  total: 0,
  offset: asked.offset,
  limit: asked.limit,
  sortedBy: asked.sortBy ?? "createdAt",
})

/** `page` and `pageSize` are dropped, not overridden: the explicit offset/limit win. */
const scopedRequest = (request: ListRequest, ids: ReadonlyArray<string>, asked: PageRequest) => ({
  ...request,
  urlParams: {
    ...request.urlParams,
    ids: ids.join(","),
    page: undefined,
    pageSize: undefined,
    offset: asked.offset,
    limit: asked.limit,
  },
})

/** The page's row ids; a defect when the handler broke PageOf or returned a row outside `visible`. */
const returnedIds = (result: unknown, visible: Visible, label: string) => {
  if (!isRecord(result) || !Array.isArray(result.rows) || typeof result.total !== "number") {
    return Effect.die("entity list violated its PageOf contract")
  }
  const ids = (result.rows as ReadonlyArray<unknown>).map((row) =>
    isRecord(row) && typeof row.id === "string" && (visible === "all" || visible.has(row.id)) ? row.id : undefined,
  )
  return ids.includes(undefined)
    ? Effect.die(new Error([label, "returned a row outside the visible ids"].join(" ")))
    : Effect.succeed(ids as ReadonlyArray<string>)
}

const listSource = (visible: Visible, roles: ReadonlyArray<string>): ListSource =>
  visible !== "all" ? "scoped" : roles.includes("admin") ? "superadmin" : "cube-admin"

/**
 * List routes: one `authorizeList`, one handler call for exactly the asked page, one `entity.list`
 * audit row (Qwbe#73). The handler filters by the injected `ids` in SQL; the wrapper checks it did.
 */
const mediateList =
  (scope: ListScope, label: string, handler: Handler, gate: Pick<Gate, "authorizeList" | "auditList">) =>
  (request: unknown) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      if (!isListRequest(request)) return yield* Effect.die("entity list needs paging params")
      const actor = actorFrom(user)
      const audit = (source: ListSource, ids: ReadonlyArray<string>) =>
        gate.auditList(actor, scope, "read", source, ids).pipe(Effect.orDie)
      const visible = yield* gate.authorizeList(actor, scope, "read").pipe(Effect.orDie)
      let inner: ListRequest = { ...request }
      if (visible !== "all") {
        // The SAME reading of the query the generic list handler does, taken BEFORE `ids` is
        // injected: an `ids` batch without a size sets the page size, and the injected set must not.
        const asked = listPageRequest(request.urlParams)
        const ids = narrowIds(request.urlParams.ids, visible)
        // Empty `ids` means "no filter" to the store, so an actor who sees nothing never reaches it.
        if (ids.length === 0) {
          yield* audit("scoped", [])
          return emptyPage(asked)
        }
        inner = scopedRequest(request, ids, asked)
      }
      const result = yield* runHandler(handler, inner)
      yield* audit(listSource(visible, user.roles), yield* returnedIds(result, visible, label))
      return result
    })

const hasPageShape = (endpoint: Pick<Endpoint, "successSchema">) => {
  const pageFields = new Set(schemaFields(endpoint.successSchema))
  return ["rows", "total", "offset", "limit", "sortedBy"].every((field) => pageFields.has(field))
}

/** The mediated handler for one endpoint; undefined leaves the plugin's own handler in place. */
const mediateEndpoint = (scope: ListScope, endpoint: Endpoint, handler: Handler, gate: Gate): Handler | undefined => {
  const parameters = schemaFields(endpoint.pathSchema)
  const label = [scope.cube, endpoint.name].join(" ")
  const refuse = () => new EntityPermissionContractError(scope.cube, endpoint.name)
  if (!containsStatus(endpoint.errorSchema, 403)) throw refuse()
  if (parameters.length > 1) throw refuse()
  if (parameters.length === 1) return guardItem(scope, parameters[0]!, actionOf(endpoint.method), handler, gate)
  if (endpoint.method === "POST") return claimCreated(scope, label, handler, gate)
  if (endpoint.method !== "GET") return undefined
  if (!hasPageShape(endpoint)) throw refuse()
  return mediateList(scope, label, handler, gate)
}

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
    const handler = handlers[endpoint.name]
    if (typeof handler !== "function") continue
    const mediated = mediateEndpoint({ cube, entityType }, endpoint, handler as Handler, permissions)
    if (mediated) protectedHandlers[endpoint.name] = mediated
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
