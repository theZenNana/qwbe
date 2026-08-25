import { Schema } from "effect"
import type { AuditEvent, AuditQuery, AuditValue } from "./permissions-model.ts"

const isAuditValue = (value: unknown): value is AuditValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isAuditValue)
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false
  return Object.values(value as Record<string, unknown>).every(isAuditValue)
}

export const AuditValueSchema = Schema.Unknown.pipe(
  Schema.filter(isAuditValue, { message: () => "audit trace must be JSON data" }),
)
export const AuditQuerySchema = Schema.Struct({
  actorUserId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  cube: Schema.optional(Schema.String),
  entityType: Schema.optional(Schema.String),
  entityId: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  result: Schema.optional(Schema.Literal("allowed", "denied", "success")),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
  offset: Schema.optionalWith(Schema.NumberFromString, { default: () => 0 }),
  limit: Schema.optionalWith(Schema.NumberFromString, { default: () => 50 }),
})
export const AuditEventSchema = Schema.Struct({
  id: Schema.String,
  traceId: Schema.String,
  timestamp: Schema.String,
  actorUserId: Schema.String,
  cube: Schema.String,
  entityType: Schema.String,
  entityId: Schema.String,
  action: Schema.String,
  result: Schema.Literal("allowed", "denied", "success"),
  before: AuditValueSchema,
  after: AuditValueSchema,
}).annotations({ identifier: "PermissionAuditEvent" })
export const AuditEventPageSchema = Schema.Struct({
  rows: Schema.Array(AuditEventSchema),
  total: Schema.Number,
  offset: Schema.Number,
  limit: Schema.Number,
  sortedBy: Schema.String,
}).annotations({ identifier: "PermissionAuditPage" })

const containsGroup = (value: AuditValue, groupId: string): boolean => {
  if (Array.isArray(value)) return (value as readonly AuditValue[]).some((item) => containsGroup(item, groupId))
  if (value === null || typeof value !== "object") return false
  const record = value as Readonly<Record<string, AuditValue>>
  return record.groupId === groupId || Object.values(record).some((item) => containsGroup(item, groupId))
}

export const matchesAuditQuery = (event: AuditEvent, query: AuditQuery): boolean =>
  (!query.actorUserId || event.actorUserId === query.actorUserId) &&
  (!query.groupId || containsGroup(event.before, query.groupId) || containsGroup(event.after, query.groupId)) &&
  (!query.cube || event.cube === query.cube) &&
  (!query.entityType || event.entityType === query.entityType) &&
  (!query.entityId || event.entityId === query.entityId) &&
  (!query.action || event.action === query.action) &&
  (!query.result || event.result === query.result) &&
  (!query.from || event.timestamp >= query.from) &&
  (!query.to || event.timestamp <= query.to)
