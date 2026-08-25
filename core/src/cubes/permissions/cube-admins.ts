import { Effect } from "effect"
import type { PermissionService } from "qwbe-core/permissions"
import { PermissionForbidden, PermissionNotFound } from "qwbe-core/permissions"
import type { PermissionState, StoredCubeAdmin } from "./state.ts"
import { tables } from "./state.ts"

export const cubeAdminsFrom = (
  state: PermissionState,
): Pick<PermissionService, "assignCubeAdmin" | "revokeCubeAdmin" | "cubeAdmins"> => {
  const requireManager = (actor: Parameters<PermissionService["assignCubeAdmin"]>[0], cube: string) =>
    state.cubeAdmin(actor, cube).pipe(
      Effect.filterOrFail(
        (allowed) => allowed,
        () => new PermissionForbidden({ message: "only superadmin or cube admin may manage cube admins" }),
      ),
      Effect.asVoid,
    )
  const rows = () => state.store.all<StoredCubeAdmin>(tables.cubeAdmins)
  const find = (cube: string, userId: string) =>
    Effect.map(rows(), (items) => items.find((row) => !row.deleted && row.cube === cube && row.userId === userId))
  const ref = (cube: string) => ({ cube, entityType: "Cube", entityId: cube })
  return {
    assignCubeAdmin: (actor, cube, userId) =>
      Effect.gen(function* () {
        yield* requireManager(actor, cube)
        const existing = yield* find(cube, userId)
        if (!existing) yield* state.store.insert(tables.cubeAdmins, "CubeAdmin", "cadm", { cube, userId })
        yield* state.writeAudit(actor, ref(cube), "cube-admin.assign", "success", existing ?? null, { cube, userId })
      }),
    revokeCubeAdmin: (actor, cube, userId) =>
      Effect.gen(function* () {
        yield* requireManager(actor, cube)
        const existing = yield* find(cube, userId)
        if (!existing) return yield* Effect.fail(new PermissionNotFound({ message: "cube admin does not exist" }))
        yield* state.store.update(tables.cubeAdmins, existing.id, { deleted: true })
        yield* state.writeAudit(actor, ref(cube), "cube-admin.revoke", "success", existing, null)
      }),
    cubeAdmins: (actor, cube) =>
      Effect.gen(function* () {
        yield* requireManager(actor, cube)
        return (yield* rows()).filter((row) => !row.deleted && row.cube === cube)
      }),
  }
}
