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
import { MAX_LIMIT } from "./kernel/pagination.ts"
import type { AccessDecision, EntityRef, PermissionActor } from "./permissions-contracts.ts"

export { EntityPermissionContractError }

type Gate = Readonly<{
  authorize: (
    actor: PermissionActor,
    ref: EntityRef,
    action: "read" | "edit" | "delete",
  ) => Effect.Effect<AccessDecision, unknown>
  claim: (actor: PermissionActor, ref: EntityRef) => Effect.Effect<unknown, unknown>
  ownership: (ref: EntityRef) => Effect.Effect<unknown>
}>

const deny = (cube: string) =>
  new Forbidden({ message: "this entity is not shared with you", needed: [cube, "entity"].join(":") })

const runHandler = (handler: Handler, request: unknown) => handler(request)

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
      protectedHandlers[endpoint.name] = (request: unknown) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          if (!isRecord(request) || !isRecord(request.urlParams))
            return yield* Effect.die("entity list needs paging params")
          // The SAME reading of the query the generic list handler does (QWB-54), so `page` and
          // `pageSize` mean here what they mean everywhere else. Read once, at the top: the
          // inner calls below are driven with an offset of this wrapper's own choosing.
          const asked = listPageRequest(request.urlParams)
          const requestedOffset = asked.offset
          const requestedLimit = Math.min(MAX_LIMIT, Math.max(1, asked.limit))
          const visible: Array<unknown> = []
          let sourceOffset = 0
          let template: Record<string, unknown> | undefined
          while (true) {
            const result = yield* runHandler(handler, {
              ...request,
              // `page` and `pageSize` are dropped, not overridden: leaving them in would make the
              // inner handler recompute an offset from the page number and walk this loop in
              // circles. `ids` and the field filters stay -- they are part of WHAT to read, and
              // narrowing them in SQL is exactly what makes this loop affordable.
              urlParams: {
                ...request.urlParams,
                page: undefined,
                pageSize: undefined,
                offset: sourceOffset,
                limit: MAX_LIMIT,
              },
            })
            if (!isRecord(result) || !Array.isArray(result.rows) || typeof result.total !== "number") {
              return yield* Effect.die("entity list violated its PageOf contract")
            }
            template = result
            const allowed = yield* Effect.filter(result.rows as ReadonlyArray<unknown>, (row) => {
              if (!isRecord(row) || typeof row.id !== "string") return Effect.succeed(false)
              return Effect.map(
                permissions.authorize(actorFrom(user), { cube, entityType, entityId: row.id }, "read"),
                (decision) => decision.allowed,
              )
            })
            for (const row of allowed) visible.push(row)
            sourceOffset += result.rows.length
            if (result.rows.length === 0 || sourceOffset >= result.total) break
          }
          return {
            ...template,
            rows: visible.slice(requestedOffset, requestedOffset + requestedLimit),
            total: visible.length,
            offset: requestedOffset,
            limit: requestedLimit,
          }
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
  manifest.entity && !manifest.providesIdentityDirectory
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
