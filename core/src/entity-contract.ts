import type { PermissionActor } from "./permissions-contracts.ts"

export type Endpoint = Readonly<{
  name: string
  method: string
  path: string
  errorSchema?: unknown
  pathSchema?: unknown
  successSchema?: unknown
}>
export type EndpointGroup = Readonly<{ endpoints: Readonly<Record<string, Endpoint>> }>
export type Handler = (request: unknown) => import("effect").Effect.Effect<unknown, unknown, unknown>

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const safeInt = (value: unknown, fallback: number): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n))) : fallback
}

export const actorFrom = (user: { id: string; roles: ReadonlyArray<string> }): PermissionActor => ({
  userId: user.id,
  roles: user.roles,
})

export const itemId = (request: unknown, parameter: string): string | undefined => {
  if (!isRecord(request) || !isRecord(request.path)) return undefined
  return typeof request.path[parameter] === "string" ? request.path[parameter] : undefined
}

export const schemaFields = (schema: unknown): ReadonlyArray<string> => {
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) return []
  const container = schema as Record<string, unknown>
  const value = container.value ?? container
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return []
  const fields = (value as Record<string, unknown>).fields
  return isRecord(fields) ? Object.keys(fields) : []
}

export class EntityPermissionContractError extends Error {
  constructor(cube: string, endpoint: string) {
    super(
      ["entity cube", JSON.stringify(cube), "endpoint", JSON.stringify(endpoint), "must declare Forbidden (403)"].join(
        " ",
      ),
    )
    this.name = "EntityPermissionContractError"
  }
}

export const containsStatus = (root: unknown, status: number): boolean => {
  const seen = new WeakSet<object>()
  const visit = (value: unknown): boolean => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false
    const object = value
    if (seen.has(object)) return false
    seen.add(object)
    for (const key of Reflect.ownKeys(object)) {
      const child = (object as Record<PropertyKey, unknown>)[key]
      if (typeof key === "symbol" && key.description?.includes("AnnotationStatus") && child === status) return true
      if (visit(child)) return true
    }
    return false
  }
  return visit(root)
}
