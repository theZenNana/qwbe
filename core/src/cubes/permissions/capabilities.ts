// Runtime cube capability grants (QWB-63): a user or a group receives one DECLARED cube
// permission (`notes:write`) on top of the static roles. The auth middleware unions
// `capabilitiesFor` into `CurrentUser.permissions`, so every route gate sees it; the entity
// gate stays a separate question answered per row by `foundation.ts`.

import { Effect, Schema } from "effect"
import type { CubeTools } from "qwbe-core/cube"
import type { CapabilityGrant, GrantSubject, PermissionActor, PermissionService } from "qwbe-core/permissions"
import {
  CapabilityGrantSchema,
  PermissionForbidden,
  PermissionInvalid,
  PermissionNotFound,
} from "qwbe-core/permissions"
import { groupById } from "./groups.ts"
import type { PermissionState } from "./state.ts"
import { tables } from "./state.ts"

type StoredCapabilityGrant = CapabilityGrant & Readonly<{ deleted?: boolean }>

/** The owning cube of a declared permission: manifest validation forces `<cube>:<name>`. */
const cubeOf = (capability: string) => capability.slice(0, capability.lastIndexOf(":"))

const sameSubject = (left: GrantSubject, right: GrantSubject) =>
  (left.kind === "user" && right.kind === "user" && left.userId === right.userId) ||
  (left.kind === "group" && right.kind === "group" && left.groupId === right.groupId)

export const capabilitiesFrom = (
  state: PermissionState,
  declared: CubeTools["permissions"],
): Pick<
  PermissionService,
  "grantCapability" | "revokeCapabilityGrant" | "listCapabilityGrants" | "capabilitiesFor"
> => {
  // ponytail: whole-table read like every other lookup in this cube; index by userId when it matters.
  const rows = () =>
    Effect.map(state.store.all<StoredCapabilityGrant>(tables.capabilities), (items) =>
      items.filter((row) => row.deleted !== true),
    )
  // Same manager rule as cube admins: superadmin, or cube admin of THAT cube. An ordinary
  // grantee is neither, so it cannot extend or re-delegate what it holds.
  const requireManager = (actor: PermissionActor, cube: string) =>
    state.cubeAdmin(actor, cube).pipe(
      Effect.filterOrFail(
        (allowed) => allowed,
        () => new PermissionForbidden({ message: "only superadmin or cube admin may manage cube capabilities" }),
      ),
      Effect.asVoid,
    )
  const ref = (cube: string) => ({ cube, entityType: "Cube", entityId: cube })
  return {
    grantCapability: (actor, subject, capability) =>
      Effect.gen(function* () {
        if (!declared().has(capability)) {
          return yield* Effect.fail(
            new PermissionInvalid({
              message: ["capability", capability, "is not declared by any mounted cube"].join(" "),
            }),
          )
        }
        const cube = cubeOf(capability)
        yield* requireManager(actor, cube)
        if (subject.kind === "group") {
          const group = yield* groupById(state, subject.groupId)
          if (!group) {
            return yield* Effect.fail(
              new PermissionNotFound({ message: ["group", subject.groupId, "does not exist"].join(" ") }),
            )
          }
          if (group.cube !== cube) {
            return yield* Effect.fail(new PermissionInvalid({ message: "group belongs to another cube" }))
          }
        }
        const existing = (yield* rows()).find(
          (row) => row.capability === capability && sameSubject(row.subject, subject),
        )
        if (existing) return existing
        const createdAt = new Date().toISOString()
        const row = yield* state.store.insert(tables.capabilities, "CapabilityGrant", "cap", {
          cube,
          capability,
          subject,
          createdBy: actor.userId,
          createdAt,
        })
        const value: CapabilityGrant = {
          id: String(row.id),
          cube,
          capability,
          subject,
          createdBy: actor.userId,
          createdAt,
        }
        yield* state.writeAudit(actor, ref(cube), ["capability.grant", subject.kind].join("."), "success", null, {
          capability,
          subject,
        })
        return value
      }),
    revokeCapabilityGrant: (actor, grantId) =>
      Effect.gen(function* () {
        const grant = (yield* rows()).find((row) => row.id === grantId)
        if (!grant) {
          return yield* Effect.fail(
            new PermissionNotFound({ message: ["capability grant", grantId, "does not exist"].join(" ") }),
          )
        }
        yield* requireManager(actor, grant.cube)
        yield* state.store.update(tables.capabilities, grantId, { deleted: true })
        yield* state.writeAudit(actor, ref(grant.cube), "capability.revoke", "success", grant, null)
      }),
    listCapabilityGrants: (actor, cube) =>
      Effect.gen(function* () {
        yield* requireManager(actor, cube)
        const own = (yield* rows()).filter((row) => row.cube === cube)
        return yield* Effect.forEach(own, (row) =>
          Schema.decodeUnknown(CapabilityGrantSchema)(row).pipe(
            Effect.mapError(
              () => new PermissionInvalid({ message: "stored capability grant violates its runtime schema" }),
            ),
          ),
        )
      }),
    capabilitiesFor: (userId) =>
      Effect.gen(function* () {
        const groups = yield* state.groupIdsFor(userId)
        const names = new Set<string>()
        for (const row of yield* rows()) {
          const mine =
            (row.subject.kind === "user" && row.subject.userId === userId) ||
            (row.subject.kind === "group" && groups.has(row.subject.groupId))
          // A grant whose cube left the system names nothing any route requires; keep it out
          // of what /auth/me reports.
          if (mine && declared().has(row.capability)) names.add(row.capability)
        }
        return [...names].sort()
      }),
  }
}
