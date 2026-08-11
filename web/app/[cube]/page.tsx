"use client"

// THE GENERIC LIST route for standalone cubes -- and the PARENT screen for a hierarchy.
//
// One file for every cube, present and future -- including ones that arrive in a plugin
// nobody has written yet. A cube with an entity gets the list. A parent (`screen: true`,
// children in the catalogue) gets a surface per child: one Booktags entry in the sidebar,
// its children drawn from the catalogue -- never from a name written here.

import Link from "next/link"
import { use, useEffect, useState } from "react"
import { ListPage } from "../../components/ListPage"
import { type CubeInfo, catalogue, screenPath } from "../../lib/api"
import { Shell } from "../Shell"

export default function List({ params }: { params: Promise<{ cube: string }> }) {
  const { cube } = use(params)
  const [info, setInfo] = useState<CubeInfo | null>(null)
  const [children, setChildren] = useState<Array<CubeInfo>>([])

  useEffect(() => {
    catalogue()
      .then((c) => {
        setInfo(c.find((x) => x.name === cube) ?? null)
        setChildren(c.filter((x) => x.parent === cube))
      })
      .catch(() => setInfo(null))
  }, [cube])

  const isParent = info !== null && !info.entity && info.screen

  return (
    <Shell>
      {isParent ? (
        <>
          <h2>{cube}</h2>
          <p className="subtitlu">
            a hierarchy of {children.length} child cube{children.length === 1 ? "" : "s"}
            {info.plugin && ` - from plugin ${info.plugin}`}
            {!info.enabled && " - switched off in Settings"}
          </p>
          <table>
            <tbody>
              {children.map((c) => (
                <tr key={c.name}>
                  <td>
                    <Link href={screenPath(c)}>{c.name.split("/")[1]}</Link>
                  </td>
                  <td className="mic">{c.entity ?? "screen"}</td>
                  <td>
                    <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "on" : "off"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {children.length === 0 && <div className="gol">No children mounted under this parent.</div>}
        </>
      ) : (
        <ListPage routeName={cube} />
      )}
    </Shell>
  )
}
