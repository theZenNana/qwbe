"use client"

// THE GENERIC DETAIL PAGE plus related lists. One file, every cube.
//
// This is where the level-1 idea pays off visibly. The page does not know that an account has
// notes. It asks `/links/{entity}/{id}`, gets group heads with totals, and draws a tab for each.
// Those groups exist because a SPACE declared them — neither cube did. Delete either cube and
// the tab disappears by itself, with nothing changed here or in the other cube.
//
// A group's rows are fetched only when someone opens that tab, and paged. The previous
// iteration fetched every row of every group on each page load.

import Link from "next/link"
import { use, useEffect, useState } from "react"
import {
  type CubeInfo,
  catalogue,
  type LinksFor,
  linkGroup,
  linksFor,
  one,
  type Paged,
  type Summary,
} from "../../../lib/api"
import { Shell } from "../../Shell"

const HIDDEN = new Set(["type", "deleted"])

export default function Detail({ params }: { params: Promise<{ cube: string; id: string }> }) {
  const { cube, id } = use(params)
  const [row, setRow] = useState<Record<string, unknown> | null>(null)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [links, setLinks] = useState<LinksFor | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [groupRows, setGroupRows] = useState<Paged<Summary> | null>(null)
  const [groupOffset, setGroupOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const LIMIT = 5

  useEffect(() => {
    one(cube, id)
      .then(setRow)
      .catch((e: Error) => setError(e.message))
    catalogue()
      .then((c) => setInfo(c.find((x) => x.name === cube) ?? null))
      .catch(() => undefined)
  }, [cube, id])

  useEffect(() => {
    if (!info?.entity) return
    linksFor(info.entity, id)
      .then((l) => {
        setLinks(l)
        // Open the first non-empty group, otherwise people see tabs and do not realise they
        // are meant to press one.
        setTab((t) => t ?? l.groups.find((g) => g.total > 0)?.cube ?? null)
      })
      .catch(() => setLinks(null))
  }, [info?.entity, id])

  useEffect(() => {
    if (!info?.entity || !tab) return
    linkGroup(info.entity, id, tab, groupOffset, LIMIT)
      .then(setGroupRows)
      .catch(() => setGroupRows(null))
  }, [info?.entity, id, tab, groupOffset])

  const fields = row ? Object.keys(row).filter((k) => !HIDDEN.has(k)) : []
  const currentGroup = links?.groups.find((g) => g.cube === tab)

  return (
    <Shell>
      <p className="mic">
        <Link href={`/${cube}`}>← {cube}</Link>
      </p>
      {/* `name` joined this list when the ERP pack arrived: a company row has no `title`, so its
          page was headed with a raw id. Additive — it only fires when the fields before it are
          absent, and it is the field a cube would naturally call its display name. */}
      <h2>{String(row?.title ?? row?.name ?? row?.username ?? row?.label ?? row?.id ?? id)}</h2>
      <p className="subtitlu">
        {info?.entity} · {id}
      </p>

      {error && <div className="eroare">{error}</div>}

      {row && (
        <div className="panou">
          <h3>Fields</h3>
          <table>
            <tbody>
              {fields.map((f) => (
                <tr key={f}>
                  <td style={{ width: 180, color: "var(--sters)" }}>{f}</td>
                  <td>
                    {row[f] === null || row[f] === "" ? (
                      <span className="mic">—</span>
                    ) : Array.isArray(row[f]) ? (
                      (row[f] as Array<unknown>).join(", ")
                    ) : (
                      String(row[f])
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {links && links.parents.filter((p) => p.summary).length > 0 && (
        <div className="panou">
          <h3>Points at</h3>
          {links.parents
            .filter((p) => p.summary)
            .map((p) => (
              <div key={p.field} className="mic">
                {p.field} → <strong style={{ color: "var(--text)" }}>{p.summary!.title}</strong> ({p.to})
              </div>
            ))}
        </div>
      )}

      <div className="panou">
        <h3>Points at it</h3>
        {(!links || links.groups.length === 0) && (
          <div className="gol">No space declares a link to {info?.entity}, or the other side is off.</div>
        )}

        {links && links.groups.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              {links.groups.map((g) => (
                <button
                  type="button"
                  key={g.cube}
                  onClick={() => {
                    setTab(g.cube)
                    setGroupOffset(0)
                  }}
                  style={tab === g.cube ? { borderColor: "var(--accent)" } : undefined}
                >
                  {g.label} ({g.total})
                </button>
              ))}
            </div>

            {groupRows && (
              <>
                <table>
                  <tbody>
                    {groupRows.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ width: 220 }}>
                          <Link href={`/${tab}/${r.id}`}>{r.title}</Link>
                        </td>
                        <td className="mic">{r.details.map((d) => `${d.key}: ${d.value || "—"}`).join(" · ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {groupRows.rows.length === 0 && <div className="gol">This group is empty.</div>}
                <div className="rand-paginare">
                  <button
                    type="button"
                    disabled={groupOffset === 0}
                    onClick={() => setGroupOffset(Math.max(0, groupOffset - LIMIT))}
                  >
                    ← back
                  </button>
                  <span>
                    {groupRows.total === 0 ? 0 : groupOffset + 1}–{Math.min(groupOffset + LIMIT, groupRows.total)} of{" "}
                    {groupRows.total}
                  </span>
                  <button
                    type="button"
                    disabled={groupOffset + LIMIT >= groupRows.total}
                    onClick={() => setGroupOffset(groupOffset + LIMIT)}
                  >
                    next →
                  </button>
                  <span className="mic">only the “{currentGroup?.label}” group was fetched, not all of them</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Shell>
  )
}
