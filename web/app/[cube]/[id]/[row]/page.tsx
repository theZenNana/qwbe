"use client"

// THE CHILD-CUBE ROW route of a hierarchy: `/<parent>/<child>/<rowId>`.
//
// `/booktags/bookmarks/bm-1` matches here as cube=booktags, id=bookmarks, row=bm-1. The
// catalogue identity is `booktags/bookmarks` (routeName); the HTTP prefix the child serves
// under may differ (`booktags-settings`). The detail component gets both -- the prefix for
// the fetch, the identity for the catalogue, links and navigation back.

import { use } from "react"
import { DetailPage } from "../../../../components/DetailPage"

export default function ChildRow({ params }: { params: Promise<{ cube: string; id: string; row: string }> }) {
  const { cube, id, row } = use(params)
  return <DetailPage cube={id} id={row} routeName={`${cube}/${id}`} />
}
