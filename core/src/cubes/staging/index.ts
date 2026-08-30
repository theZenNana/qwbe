// The STAGING cube -- a generic landing zone for any migration. Import a source (JSON Lines or
// CSV, one file is one set) as raw jsonb rows, then profile it per field: how full the field
// is, how many distinct values, which shapes appear (number, date, email, phone, small enum,
// free text) and truncated example values. The point: see the SHAPE of a source before
// deciding the shape of the target cube.
//
// It knows nothing about vtiger, CRM or any other cube. No mapping, no writes anywhere else --
// that is a later ticket (QWB-50). Nothing here reads the filesystem either: the kernel owns
// the filesystem and no declared capability lends it to a cube, so rows arrive over HTTP in
// text chunks that THIS cube parses server side -- which is also what makes per-line malformed
// reporting possible.

import { type CubeTools, defineCube } from "qwbe-core/cube"
import { asBatchStore } from "./batch.ts"
import { TABLES } from "./contract.ts"
import { stagingGroup } from "./group.ts"
import { stagingHandlers } from "./handlers.ts"

export const cube = defineCube(stagingGroup, {
  manifest: {
    name: "staging",
    tables: [TABLES.sets, TABLES.rows],
    requiresAuth: true,
    permissions: [
      { name: "staging:read", roles: ["admin", "reader"] },
      { name: "staging:write", roles: ["admin"] },
    ],
    publishes: ["staging.set.created"],
  },

  create: (tools: CubeTools) => stagingHandlers(tools, asBatchStore(tools.store)),
})
