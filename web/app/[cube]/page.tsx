"use client"

// THE GENERIC LIST. One file for every cube, present and future — including ones that arrive in
// a plugin nobody has written yet.
//
// Columns are derived from the rows that come back, not from a schema written here. Paging comes
// from the response (`total`, `offset`, `limit`), so the buttons know where they are without
// counting anything. That is what `total` in the contract buys: without it this page would have
// to fetch every row to learn how many there are — the same problem, moved to the browser.

import Link from "next/link"
import { use, useEffect, useState } from "react"
import { type CubeInfo, catalogue, list, type Paged } from "../../lib/api"
import { Shell } from "../Shell"

const META = new Set(["id", "type", "createdAt", "deleted"])

export default function List({ params }: { params: Promise<{ cube: string }> }) {
  const { cube } = use(params)
  const [page, setPage] = useState<Paged<Record<string, unknown>> | null>(null)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const LIMIT = 10

  useEffect(() => {
    setError(null)
    catalogue()
      .then((c) => setInfo(c.find((x) => x.name === cube) ?? null))
      .catch(() => setInfo(null))
    list(cube, offset, LIMIT)
      .then(setPage)
      .catch((e: Error) => {
        setPage(null)
        setError(e.message)
      })
  }, [cube, offset])

  const columns = page && page.rows.length > 0 ? Object.keys(page.rows[0]!).filter((k) => !META.has(k)) : []

  return (
    <Shell>
      <h2>{cube}</h2>
      <p className="subtitlu">
        {info?.entity ? `entity ${info.entity}` : "cube without an entity"}
        {info?.plugin && ` · from plugin ${info.plugin}`}
        {info && !info.enabled && " · switched off in Settings"}
      </p>

      {error && (
        <div className="eroare">
          {error}
          {info && !info.enabled && " — the cube is off; switch it on in Settings."}
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
                    <Link href={`/${cube}/${String(r.id)}`}>{String(r.id)}</Link>
                  </td>
                  {columns.map((c) => (
                    <td key={c}>
                      {r[c] === null || r[c] === "" ? (
                        <span className="mic">—</span>
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
              ← back
            </button>
            <span>
              {page.total === 0 ? 0 : offset + 1}–{Math.min(offset + LIMIT, page.total)} of {page.total}
            </span>
            <button type="button" disabled={offset + LIMIT >= page.total} onClick={() => setOffset(offset + LIMIT)}>
              next →
            </button>
            <span className="mic">limit sent: {page.limit}</span>
          </div>
        </>
      )}
    </Shell>
  )
}
