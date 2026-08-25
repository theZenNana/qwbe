import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { BadRequest, Forbidden, NotFound } from "qwbe-core/errors"
import { PermissionConflict, PermissionForbidden, PermissionInvalid, PermissionNotFound } from "qwbe-core/permissions"
import { permissionHttpError } from "./handler-utils.ts"

describe("permissions HTTP error mapping", () => {
  it("maps every public permission failure to its stable HTTP error", () => {
    assert.ok(permissionHttpError("x")(new PermissionNotFound({ message: "missing" })) instanceof NotFound)
    assert.ok(permissionHttpError("x")(new PermissionInvalid({ message: "invalid" })) instanceof BadRequest)
    assert.equal(permissionHttpError("x")(new PermissionConflict({ message: "conflict" }))._tag, "Conflict")
    assert.ok(permissionHttpError("x")(new PermissionForbidden({ message: "denied" })) instanceof Forbidden)
  })
})
