// The package API functions - the settings-cube package surface.
//
// Split out of `api.ts` for the per-file size cap when scan + forget joined the family:
// the package surface (list, install, install-from, scan, forget shelf, uninstall) is one
// coherent unit and its doc comments are half its size. `api.ts` re-exports everything here,
// so callers keep a single facade while this file carries the real seam.

import { Schema } from "effect"
import { request } from "./api.ts"
import {
  InstallFromResultSchema,
  InstallResultSchema,
  PackageInfoSchema,
  RemoveResultSchema,
  ScanResultSchema,
} from "./contracts.ts"

export const packages = async () => [...(await request("/settings/packages", Schema.Array(PackageInfoSchema)))]

export const installPackage = (name: string) =>
  request(`/settings/packages/${name}/install`, InstallResultSchema, { method: "POST" })

/**
 * Install from a directory the administrator points at. The path is absolute on the SERVER -
 * the kernel validates, stages and copies it; the browser never touches the bytes.
 */
export const installFromDirectory = (path: string) =>
  request(`/settings/packages/install-from`, InstallFromResultSchema, {
    method: "POST",
    body: JSON.stringify({ path }),
  })

/**
 * Discover installable packages under a server directory, one level deep, each with the store
 * state it would meet: no copy, an identical copy (reused), or different content (refused
 * until the shelf is forgotten).
 */
export const scanPackages = (path: string) =>
  request(`/settings/packages/scan`, ScanResultSchema, {
    method: "POST",
    body: JSON.stringify({ path }),
  })

/**
 * Drop a store shelf copy that nothing is installed from. The counterpart install-from needs
 * for the dev loop: same name with edited content is refused until this runs.
 */
export const forgetShelf = (name: string) =>
  request(`/settings/packages/${encodeURIComponent(name)}/shelf`, RemoveResultSchema, { method: "DELETE" })

/**
 * Undo an install by PACKAGE name -- the only way back before a restart.
 *
 * `removeCube` (in api.ts) takes a mounted cube, and installing does not mount. So between
 * installing something by accident and restarting, that route cannot reach it.
 */
export const uninstallPackage = (name: string) =>
  request(`/settings/packages/${name}`, RemoveResultSchema, { method: "DELETE" })
