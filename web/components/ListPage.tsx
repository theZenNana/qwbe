"use client"

// THE GENERIC LIST as a component -- shared by the standalone route (`/[cube]`) and by the
// child route (`/booktags/bookmarks`), where `[cube]/[id]` detects that `id` is not a row
// but a mounted child cube.
//
// `routeName` is the cube's identity (`booktags/bookmarks`); the HTTP prefix it serves
// under comes from the catalogue (`prefix`), so this component still knows nothing about
// which cubes exist.

import Link from "next/link"
import { useEffect, useState } from "react"
import {
  type CubeInfo,
  catalogue,
  type EntityGrant,
  type EntityVisibility,
  entityGrants,
  list,
  one,
  type Paged,
  type PermissionGroup,
  permissionGroups,
  revokeEntityGrant,
  screenPath,
  setEntityHidden,
  shareEntityWithGroup,
  shareEntityWithUser,
  type VisibilityView,
  visibleEntities,
} from "../lib/api"
import { canManageGrants } from "../lib/permissions-ui.ts"
import { EntityVisibilityControls, VisibilityControls } from "./VisibilityControls.tsx"

const META = new Set(["id", "type", "createdAt", "deleted"])

export function ListPage({ routeName, back }: { routeName: string; back?: string }) {
  const [page, setPage] = useState<Paged<Record<string, unknown>> | null>(null)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [offset, setOffset] = useState(0)
  const [visibility, setVisibility] = useState<ReadonlyArray<EntityVisibility>>([])
  const [groups, setGroups] = useState<ReadonlyArray<PermissionGroup>>([])
  const [grants, setGrants] = useState<ReadonlyMap<string, ReadonlyArray<EntityGrant>>>(new Map())
  const [view, setView] = useState<VisibilityView>("all")
  const [hiddenCount, setHiddenCount] = useState(0)
  const [pendingVisibility, setPendingVisibility] = useState<string | null>(null)
  const [visibilityVersion, setVisibilityVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const LIMIT = 10

  useEffect(() => {
    // Mutation completion increments this value solely to re-run the remote read.
    void visibilityVersion
    setError(null)
    catalogue()
      .then((c) => {
        const found = c.find((x) => x.name === routeName) ?? null
        setInfo(found)
        const prefix = found?.prefix
        if (!prefix) throw new Error(`cube "${routeName}" has no list screen`)
        if (!found.entityPermissions) {
          setVisibility([])
          return list(prefix, offset, LIMIT)
        }
        // Calling the entity cube first lets it claim legacy rows through the same public list
        // seam. The response is not rendered until Permissions has filtered it.
        return list(prefix, offset, LIMIT).then(async () => {
          const [visible, hidden] = await Promise.all([
            visibleEntities(routeName, view, offset, LIMIT),
            visibleEntities(routeName, "hidden-by-me", 0, 1),
          ])
          const rows = await Promise.all(visible.rows.map((entry) => one(prefix, entry.entityId)))
          const availableGroups = await permissionGroups(routeName).catch(() => [])
          const grantEntries = await Promise.all(
            visible.rows.map(
              async (entry) =>
                [entry.entityId, canManageGrants(entry.access.source) ? (await entityGrants(entry)).rows : []] as const,
            ),
          )
          setVisibility(visible.rows)
          setHiddenCount(hidden.total)
          setGroups(availableGroups)
          setGrants(new Map(grantEntries))
          return { ...visible, rows }
        })
      })
      .then(setPage)
      .catch((e: Error) => {
        setPage(null)
        setError(e.message)
      })
  }, [routeName, offset, view, visibilityVersion])

  const columns = page && page.rows.length > 0 ? Object.keys(page.rows[0]!).filter((k) => !META.has(k)) : []
  // Row detail lives on the cube's SCREEN path: standalone `/<name>/<id>`, a child at
  // `/<parent>/<child>/<id>` -- the third segment is the row, matched by [cube]/[id]/[row].
  const rowHref = (id: string) => (info ? `${screenPath(info)}/${id}` : `/${routeName}/${id}`)
  const visibilityById = new Map(visibility.map((entry) => [entry.entityId, entry]))

  const mutateEntity = (entry: EntityVisibility, mutation: () => Promise<unknown>): Promise<void> => {
    setPendingVisibility(entry.entityId)
    setError(null)
    return mutation()
      .then(() => setVisibilityVersion((version) => version + 1))
      .catch((e: Error) => setError(e.message))
      .finally(() => setPendingVisibility(null))
  }

  const changeVisibility = (entry: EntityVisibility, hidden: boolean) =>
    mutateEntity(entry, () => setEntityHidden(entry, hidden))

  return (
    <>
      {back && (
        <p className="mic">
          <Link href={back}>
            {"<-"} {back.replace("/", "")}
          </Link>
        </p>
      )}
      <h2>{routeName}</h2>
      <p className="subtitlu">
        {info?.entity ? `entity ${info.entity}` : "cube without an entity"}
        {info?.parent && ` - child of ${info.parent}`}
        {info?.plugin && ` - from plugin ${info.plugin}`}
        {info && !info.enabled && " - switched off in Settings"}
      </p>

      {error && (
        <div className="eroare">
          {error}
          {info && !info.enabled && " -- the cube is off; switch it on in Settings."}
        </div>
      )}

      {info?.entityPermissions && (
        <VisibilityControls
          value={view}
          hiddenCount={hiddenCount}
          onChange={(next) => {
            setOffset(0)
            setView(next)
          }}
        />
      )}

      {page && (
        <>
          <table>
            <thead>
              <tr>
                <th>id</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((r) => {
                const id = String(r.id)
                const entityVisibility = visibilityById.get(id)
                return (
                  <tr key={id}>
                    <td>
                      <Link href={rowHref(id)}>{id}</Link>
                      {entityVisibility && (
                        <EntityVisibilityControls
                          value={entityVisibility}
                          pending={pendingVisibility === id}
                          onChange={(hidden) => changeVisibility(entityVisibility, hidden)}
                          groups={groups}
                          grants={grants.get(entityVisibility.entityId) ?? []}
                          onShareUser={(username, actions) =>
                            mutateEntity(entityVisibility, () =>
                              shareEntityWithUser(entityVisibility, username, actions),
                            )
                          }
                          onShareGroup={(groupId, actions) =>
                            mutateEntity(entityVisibility, () =>
                              shareEntityWithGroup(entityVisibility, groupId, actions),
                            )
                          }
                          onRevoke={(grant) => mutateEntity(entityVisibility, () => revokeEntityGrant(grant))}
                        />
                      )}
                    </td>
                    {columns.map((c) => (
                      <td key={c}>
                        {r[c] === null || r[c] === "" ? (
                          <span className="mic">--</span>
                        ) : Array.isArray(r[c]) ? (
                          (r[c] as Array<unknown>).join(", ")
                        ) : (
                          String(r[c])
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>

          {page.rows.length === 0 && <div className="gol">Nothing here yet.</div>}

          <div className="rand-paginare">
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
              {"<-"} back
            </button>
            <span>
              {page.total === 0 ? 0 : offset + 1}-{Math.min(offset + LIMIT, page.total)} of {page.total}
            </span>
            <button type="button" disabled={offset + LIMIT >= page.total} onClick={() => setOffset(offset + LIMIT)}>
              next {"->"}
            </button>
            <span className="mic">limit sent: {page.limit}</span>
          </div>
        </>
      )}
    </>
  )
}
