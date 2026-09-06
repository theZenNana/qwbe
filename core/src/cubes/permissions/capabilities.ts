// Runtime cube capability grants (QWB-63): a user or a group receives one DECLARED cube
// permission (`notes:write`) on top of the static roles. The auth middleware unions
// `capabilitiesFor` into `CurrentUser.permissions`, so every route gate sees it; the entity
// gate stays a separate question answered per row by `foundation.ts`.
//
// Policy (approved spec, QWB-63): every permission a mounted cube declares is grantable,
// kernel cubes included. There is no allowlist; containment is the manager rule below --
// only superadmin or a cube admin of THAT cube may grant it, and the grant never crosses cubes.
//
// Reads go through the store's `where` filter (`state.every`), never a whole-table scan: the
// auth middleware calls `capabilitiesFor` on every request. The subject is kept flat in
// `subjectKey` (`user:<id>` / `group:<id>`) because the store filters one top-level field.
//
// Duplicates: the CubeStore contract has no unique or conditional insert, so two concurrent
// grants of the same (capability, subject) can both land. Access already de-duplicates;
// revoke retires EVERY live row of the target's (capability, subject), so a revoke is
// complete whichever id the manager passes. ponytail: a unique index needs a store primitive.

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

type StoredCapabilityGrant = CapabilityGrant & Readonly<{ subjectKey: string; deleted?: boolean }>

/** The owning cube of a declared permission: manifest validation forces `<cube>:<name>`. */
const cubeOf = (capability: string) => capability.slice(0, capability.lastIndexOf(":"))

const subjectKeyOf = (subject: GrantSubject) =>
  subject.kind === "user" ? ["user", subject.userId].join(":") : ["group", subject.groupId].join(":")

export const capabilitiesFrom = (
  state: PermissionState,
  declared: CubeTools["permissions"],
): Pick<
  PermissionService,
  "grantCapability" | "revokeCapabilityGrant" | "listCapabilityGrants" | "capabilitiesFor"
> => {
  const live = (rows: ReadonlyArray<StoredCapabilityGrant>) => rows.filter((row) => row.deleted !== true)
  const bySubject = (subjectKey: string) =>
    Effect.map(state.every<StoredCapabilityGrant>(tables.capabilities, "subjectKey", subjectKey), live)
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
  const publish = (row: StoredCapabilityGrant): CapabilityGrant => ({
    id: row.id,
    cube: row.cube,
    capability: row.capability,
    subject: row.subject,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  })
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
        const subjectKey = subjectKeyOf(subject)
        const existing = (yield* bySubject(subjectKey)).find((row) => row.capability === capability)
        const createdAt = new Date().toISOString()
        const row = existing
          ? existing
          : ((yield* state.store.insert(tables.capabilities, "CapabilityGrant", "cap", {
              cube,
              capability,
              subject,
              subjectKey,
              createdBy: actor.userId,
              createdAt,
            })) as StoredCapabilityGrant)
        const value = publish({ ...row, id: String(row.id) })
        // A repeat is audited like `cube-admin.assign`: same action, the existing row as `before`.
        yield* state.writeAudit(
          actor,
          ref(cube),
          ["capability.grant", subject.kind].join("."),
          "success",
          existing ? publish(existing) : null,
          value,
        )
        return value
      }),
    revokeCapabilityGrant: (actor, grantId) =>
      Effect.gen(function* () {
        const grant = yield* state.store.byId<StoredCapabilityGrant>(tables.capabilities, grantId)
        if (!grant || grant.deleted === true) {
          return yield* Effect.fail(
            new PermissionNotFound({ message: ["capability grant", grantId, "does not exist"].join(" ") }),
          )
        }
        yield* requireManager(actor, grant.cube)
        const twins = (yield* bySubject(grant.subjectKey)).filter((row) => row.capability === grant.capability)
        yield* Effect.forEach(twins, (row) => state.store.update(tables.capabilities, row.id, { deleted: true }))
        yield* state.writeAudit(actor, ref(grant.cube), "capability.revoke", "success", publish(grant), null)
      }),
    listCapabilityGrants: (actor, cube) =>
      Effect.gen(function* () {
        yield* requireManager(actor, cube)
        const own = live(yield* state.every<StoredCapabilityGrant>(tables.capabilities, "cube", cube))
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
        // ponytail: one filtered read per group of the user; an `IN` filter needs a store primitive.
        const keys = [
          subjectKeyOf({ kind: "user", userId }),
          ...[...groups].map((groupId) => subjectKeyOf({ kind: "group", groupId })),
        ]
        const names = new Set<string>()
        for (const key of keys) {
          for (const row of yield* bySubject(key)) {
            // A grant whose cube left the system names nothing any route requires; keep it out
            // of what /auth/me reports.
            if (declared().has(row.capability)) names.add(row.capability)
          }
        }
        return [...names].sort()
      }),
  }
}
