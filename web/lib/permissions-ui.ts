import type { EntityGrant, EntityRef, EntityVisibility, VisibilityView } from "qwbe-core/permissions"
import { EntityActions } from "qwbe-core/permissions"

export const grantActionOptions = EntityActions

export const canManageGrants = (source: EntityVisibility["access"]["source"]): boolean =>
  source === "owner" || source === "cube-admin" || source === "superadmin"

const entityPermissionsPath = (ref: EntityRef): string =>
  `/permissions/entities/${encodeURIComponent(ref.cube)}/${encodeURIComponent(ref.entityType)}/${encodeURIComponent(ref.entityId)}`

export const grantsListPath = (ref: EntityRef, offset = 0, limit = 20): string =>
  `${entityPermissionsPath(ref)}/grants?offset=${offset}&limit=${limit}`

export const revokeGrantPath = (grantId: string): string => `/permissions/grants/${encodeURIComponent(grantId)}`

export const grantLabel = (grant: EntityGrant): string => {
  const subject = grant.subject.kind === "user" ? `USER ${grant.subject.userId}` : `GROUP ${grant.subject.groupId}`
  return `${subject} - ${grant.actions.map((action) => action.toUpperCase()).join(" + ")}`
}

export interface VisibilityPresentation {
  readonly badges: ReadonlyArray<string>
  readonly visibilityAction: "hide" | "unhide"
}

export const visibilityOptions = (
  hiddenCount: number,
): ReadonlyArray<{ readonly value: VisibilityView; readonly label: string }> => [
  { value: "all", label: "Toate" },
  { value: "owned-by-me", label: "Ale mele" },
  { value: "created-by-me", label: "Create de mine" },
  { value: "only-mine", label: "Doar ale mele" },
  { value: "shared-by-me", label: "Partajate de mine" },
  { value: "shared-with-me", label: "Partajate cu mine" },
  { value: "hidden-by-me", label: `Ascunse: ${hiddenCount}` },
]

export const permissionsListPath = (
  cube: string,
  input: {
    readonly view: VisibilityView
    readonly sortBy?: "createdAt" | "entityId" | "ownerId" | "createdBy"
    readonly descending?: boolean
    readonly offset: number
    readonly limit: number
  },
): string => {
  const query = new URLSearchParams({
    view: input.view,
    sortBy: input.sortBy ?? "createdAt",
    descending: String(input.descending ?? true),
    offset: String(input.offset),
    limit: String(input.limit),
  })
  return `/permissions/entities/${encodeURIComponent(cube)}?${query.toString()}`
}

export const visibilityMutationPath = (ref: EntityRef): string => `${entityPermissionsPath(ref)}/visibility`

const actionsLabel = (actions: ReadonlyArray<string>): string =>
  actions.map((action) => action.toUpperCase()).join(" + ")

export const visibilityPresentation = (provenance: EntityVisibility): VisibilityPresentation => {
  const badges: Array<string> = []

  if (provenance.access.source === "owner") {
    badges.push("A MEA")
    if (provenance.createdBy === provenance.ownerId) badges.push("CREATED BY ME")
    badges.push(provenance.sharedWithCount === 0 ? "ONLY MINE" : `SHARED: ${provenance.sharedWithCount}`)
  } else {
    const sourceLabel =
      provenance.access.source === "creator"
        ? "CREATED BY ME"
        : provenance.access.source === "cube-admin"
          ? "CUBE ADMIN"
          : provenance.access.source === "superadmin"
            ? "SUPERADMIN"
            : "PARTAJAT CU MINE"
    badges.push(sourceLabel, `OWNER: ${provenance.ownerId}`, actionsLabel(provenance.access.actions))
  }

  if (provenance.hidden) badges.push("HIDDEN")
  return { badges, visibilityAction: provenance.hidden ? "unhide" : "hide" }
}
