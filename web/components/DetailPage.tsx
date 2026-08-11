"use client"

// THE GENERIC DETAIL PAGE plus related lists, as a component. One file, every cube.
//
// Split out of `app/[cube]/[id]/page.tsx` on 2026-08-11 (file cap) when that route also
// became the child-cube route of a hierarchy. The route file keeps only the fork between
// "id is a row" and "id is a mounted child".
//
// The page does not know that an account has notes. It asks `/links/{entity}/{id}`, gets
// group heads with totals, and draws a tab for each. Those groups exist because a SPACE
// declared them -- neither cube did. Delete either cube and the tab disappears by itself,
// with nothing changed here or in the other cube.
//
// A group's rows are fetched only when someone opens that tab, and paged. The previous
// iteration fetched every row of every group on each page load.

import Link from "next/link"
import { useEffect, useState } from "react"
import { Shell } from "../app/Shell"
import {
  type CubeInfo,
  catalogue,
  type LinksFor,
  linkGroup,
  linksFor,
  one,
  type Paged,
  type Summary,
  screenPath,
} from "../lib/api"

const HIDDEN = new Set(["type", "deleted"])

export function DetailPage({ cube, id, routeName }: { cube: string; id: string; routeName?: string }) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [catalog, setCatalog] = useState<Array<CubeInfo>>([])
  const [links, setLinks] = useState<LinksFor | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [groupRows, setGroupRows] = useState<Paged<Summary> | null>(null)
  const [groupOffset, setGroupOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const LIMIT = 5

  useEffect(() => {
    // The catalogue identity (routeName for a child, e.g. `booktags/bookmarks`) is what the
    // kernel knows the cube as; the HTTP prefix comes from the catalogue too -- a child whose
    // leaf name is taken serves under `<parent>-<name>`, so the leaf must never be assumed.
    const identity = routeName ?? cube
    catalogue()
      .then((c) => {
        setCatalog(c)
        const found = c.find((x) => x.name === identity) ?? null
        setInfo(found)
        return one(found?.prefix ?? cube, id)
      })
      .then(setRow)
      .catch((e: Error) => setError(e.message))
  }, [cube, id, routeName])

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
  const identity = routeName ?? cube

  // A field whose value is a mounted cube's name renders as a link to that cube's screen --
  // "navigate back to it" is the product behaviour of a bookmark. Detected by shape, not by
  // name: any cube field that matches a catalogue entry links, any other value is text.
  const cubeLink = (value: unknown): string | null => {
    if (typeof value !== "string" || value === "") return null
    const target = catalog.find((c) => c.name === value)
    return target ? screenPath(target) : null
  }

  return (
    <Shell>
      <p className="mic">
        <Link href={`/${identity}`}>
          {"<-"} {identity}
        </Link>
      </p>
      {/* `name` joined this list when the ERP pack arrived: a company row has no `title`, so its
          page was headed with a raw id. Additive -- it only fires when the fields before it are
          absent, and it is the field a cube would naturally call its display name. */}
      <h2>{String(row?.title ?? row?.name ?? row?.username ?? row?.label ?? row?.id ?? id)}</h2>
      <p className="subtitlu">
        {info?.entity} - {id}
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
                      <span className="mic">--</span>
                    ) : cubeLink(row[f]) !== null ? (
                      <Link href={cubeLink(row[f]) as string}>{String(row[f])}</Link>
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
                {p.field} {"->"} <strong style={{ color: "var(--text)" }}>{p.summary!.title}</strong> ({p.to})
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
                        <td className="mic">{r.details.map((d) => `${d.key}: ${d.value || "--"}`).join(" - ")}</td>
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
                    {"<-"} back
                  </button>
                  <span>
                    {groupRows.total === 0 ? 0 : groupOffset + 1}-{Math.min(groupOffset + LIMIT, groupRows.total)} of{" "}
                    {groupRows.total}
                  </span>
                  <button
                    type="button"
                    disabled={groupOffset + LIMIT >= groupRows.total}
                    onClick={() => setGroupOffset(groupOffset + LIMIT)}
                  >
                    next {"->"}
                  </button>
                  <span className="mic">only the "{currentGroup?.label}" group was fetched, not all of them</span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Shell>
  )
}
