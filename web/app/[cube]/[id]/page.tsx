"use client"

// THE GENERIC DETAIL ROUTE -- and the child-cube route of a hierarchy.
//
// `/booktags/bookmarks` matches here as cube=booktags, id=bookmarks: when the catalogue
// says `<cube>/<id>` is a mounted child, this is its list screen, not a row detail. The
// detail component lives in components/DetailPage.tsx (file cap); this file is the route
// and the fork. Nothing about Booktags is written here -- any parent works the same.

import { use, useEffect, useState } from "react"
import { DetailPage } from "../../../components/DetailPage"
import { ListPage } from "../../../components/ListPage"
import { catalogue } from "../../../lib/api"
import { Shell } from "../../Shell"

export default function Detail({ params }: { params: Promise<{ cube: string; id: string }> }) {
  const { cube, id } = use(params)
  const [isChild, setIsChild] = useState<boolean | null>(null)

  useEffect(() => {
    catalogue()
      .then((c) => setIsChild(c.some((x) => x.name === `${cube}/${id}`)))
      .catch(() => setIsChild(false))
  }, [cube, id])

  if (isChild === null) return <Shell>{null}</Shell>
  if (isChild) {
    return (
      <Shell>
        <ListPage routeName={`${cube}/${id}`} back={`/${cube}`} />
      </Shell>
    )
  }
  return <DetailPage cube={cube} id={id} />
}
