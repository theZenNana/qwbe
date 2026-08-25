import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Schema } from "effect"
import { AuditEventSchema } from "qwbe-core/permissions"

const event = {
  id: "audit-1",
  traceId: "trace-1",
  timestamp: "2026-08-15T00:00:00.000Z",
  actorUserId: "ana",
  cube: "crm/contacts",
  entityType: "Contact",
  entityId: "contact-1",
  action: "grant.group",
  result: "success",
  before: null,
}

describe("permissions audit public contract", () => {
  it("accepts JSON before/after traces", () => {
    assert.deepEqual(Schema.decodeUnknownSync(AuditEventSchema)({ ...event, after: { groupId: "grp-1" } }).after, {
      groupId: "grp-1",
    })
  })

  it("rejects runtime values that cannot be represented in JSON", () => {
    assert.throws(() => Schema.decodeUnknownSync(AuditEventSchema)({ ...event, after: new Date() }))
  })
})
