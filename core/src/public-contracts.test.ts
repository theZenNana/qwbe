import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Authorization, CurrentUser, requirePermission } from "qwbe-core/auth"
import { EntityMeta } from "qwbe-core/entity"
import { BadRequest, Forbidden, NotFound, Unauthorized } from "qwbe-core/errors"
import { PageParams, pageRequest } from "qwbe-core/pagination"

describe("public plugin contracts", () => {
  it("resolve without importing private kernel paths", () => {
    assert.equal(typeof Authorization, "function")
    assert.equal(typeof CurrentUser, "function")
    assert.equal(typeof requirePermission, "function")
    assert.equal(typeof EntityMeta, "object")
    assert.equal(typeof BadRequest, "function")
    assert.equal(typeof Forbidden, "function")
    assert.equal(typeof NotFound, "function")
    assert.equal(typeof Unauthorized, "function")
    assert.ok(PageParams)
    assert.deepEqual(pageRequest({ limit: 3 }), { offset: 0, limit: 3, sortBy: undefined, descending: false })
  })
})
