// Sections 7 and 8: manifests that lie, and two cubes reaching for the same table.
//
// These are checked at MOUNT, so they are exercised against the validators directly rather than
// over HTTP — a lying manifest never reaches a running server, which means an HTTP-only probe
// could never see them refused.

import { join } from "node:path"
import { root } from "./lib.mjs"

export const manifestLies = async ({ score }) => {
  const { validateManifest, validateCommands } = await import(join(root, "core/src/kernel/manifest.ts"))

  let rejectedWrongName = false
  try {
    validateManifest("notes", { name: "account", tables: [], requiresAuth: true })
  } catch {
    rejectedWrongName = true
  }
  score.check("manifest: a cube cannot claim another cube's name", rejectedWrongName)

  let rejectedForeignPermission = false
  try {
    validateManifest("notes", {
      name: "notes",
      tables: [],
      requiresAuth: true,
      permissions: [{ name: "account:write", roles: ["admin"] }],
    })
  } catch {
    rejectedForeignPermission = true
  }
  score.check("manifest: a cube cannot grant itself another cube's permission", rejectedForeignPermission)

  let rejectedForeignCommand = false
  try {
    validateCommands(
      { name: "notes", tables: [], requiresAuth: true, permissions: [{ name: "notes:read", roles: [] }] },
      [{ name: "account:wipe", summary: "", permission: "notes:read", run: () => undefined }],
    )
  } catch {
    rejectedForeignCommand = true
  }
  score.check("manifest: a cube cannot declare a command under another cube's prefix", rejectedForeignCommand)

  let rejectedUnownedPermission = false
  try {
    validateCommands(
      { name: "notes", tables: [], requiresAuth: true, permissions: [{ name: "notes:read", roles: [] }] },
      [{ name: "notes:danger", summary: "", permission: "settings:write", run: () => undefined }],
    )
  } catch {
    rejectedUnownedPermission = true
  }
  score.check(
    "manifest: a command cannot require a permission its cube does not declare",
    rejectedUnownedPermission,
    "otherwise a cube could gate its command on a permission only admins hold, then widen it later",
  )
}

export const tableOwnership = async ({ score }) => {
  const { checkUniqueTables } = await import(join(root, "core/src/kernel/store.ts"))
  let rejectedDoubleOwner = false
  try {
    checkUniqueTables([
      { name: "notes", tables: ["notes"] },
      { name: "evil", tables: ["notes"] },
    ])
  } catch {
    rejectedDoubleOwner = true
  }
  score.check(
    "tables: two cubes cannot declare the same table",
    rejectedDoubleOwner,
    "a valid manifest was the obvious way around the store, and it is closed",
  )
}
