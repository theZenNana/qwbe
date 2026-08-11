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
import { type CubeInfo, catalogue, list, type Paged, screenPath } from "../lib/api"

const META = new Set(["id", "type", "createdAt", "deleted"])

export function ListPage({ routeName, back }: { routeName: string; back?: string }) {
  const [page, setPage] = useState<Paged<Record<string, unknown>> | null>(null)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const LIMIT = 10

  useEffect(() => {
    setError(null)
    catalogue()
      .then((c) => {
        const found = c.find((x) => x.name === routeName) ?? null
        setInfo(found)
        const prefix = found?.prefix
        if (!prefix) throw new Error(`cube "${routeName}" has no list screen`)
        return list(prefix, offset, LIMIT)
      })
      .then(setPage)
      .catch((e: Error) => {
        setPage(null)
        setError(e.message)
      })
  }, [routeName, offset])

  const columns = page && page.rows.length > 0 ? Object.keys(page.rows[0]!).filter((k) => !META.has(k)) : []
  // Row detail lives on the cube's SCREEN path: standalone `/<name>/<id>`, a child at
  // `/<parent>/<child>/<id>` -- the third segment is the row, matched by [cube]/[id]/[row].
  const rowHref = (id: string) => (info ? `${screenPath(info)}/${id}` : `/${routeName}/${id}`)

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
              {page.rows.map((r) => (
                <tr key={String(r.id)}>
                  <td>
                    <Link href={rowHref(String(r.id))}>{String(r.id)}</Link>
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
              ))}
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
