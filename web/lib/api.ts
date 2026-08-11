// The only thing this frontend knows about the backend: its address.
//
// There is no generated client and no type imported from the API. The contract is composed at
// runtime from whatever cubes are on disk, so a static client would either be wrong or would
// force the cube list back into code. What the frontend uses instead is the catalogue: names,
// shapes, links, commands. A new cube -- or a whole plugin -- appears without a rebuild here.

import { endSession, session } from "./session"

export const BASE = process.env.NEXT_PUBLIC_QWBE_API ?? "http://127.0.0.1:4500"

export type CubeInfo = {
  name: string
  /** The parent cube's name for a child (`booktags`), or null for standalone cubes. */
  parent: string | null
  /** First URL segment this cube serves under; children whose leaf name is taken serve
   *  under `<parent>-<name>`. Null for cubes with no routes. */
  prefix: string | null
  enabled: boolean
  required: boolean
  system: boolean
  plugin: string | null
  onDisk: boolean
  entity: string | null
  screen: boolean
  publishes: Array<string>
  links: Array<{ to: string; field: string; label: string }>
}

export type Summary = { id: string; title: string; details: Array<{ key: string; value: string }> }
export type Paged<A> = { rows: Array<A>; total: number; offset: number; limit: number }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const request = async <A>(path: string, options: RequestInit = {}): Promise<A> => {
  const r = await fetch(BASE + path, {
    ...options,
    headers: { "content-type": "application/json", ...session.headers(), ...(options.headers ?? {}) },
  })
  const text = await r.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!r.ok) {
    // A 401 mid-session means the token died -- send the person back to the door rather than
    // rendering an error they can do nothing about.
    if (r.status === 401 && session.read()) endSession()
    throw new ApiError(r.status, (body as { message?: string })?.message ?? `HTTP ${r.status}`)
  }
  return body as A
}

export const login = async (username: string, password: string) => {
  const r = await request<{ token: string; expiresAt: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  })
  session.write(r)
  return r
}

export const logout = async () => {
  await request("/auth/logout", { method: "POST" }).catch(() => undefined)
  session.clear()
}

export const catalogue = () => request<Array<CubeInfo>>("/settings/cubes")
export const toggleCube = (name: string, enabled: boolean) =>
  request<CubeInfo>(`/settings/cubes/${encodeURIComponent(name)}`, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })

// --- installing -------------------------------------------------------------------------------
//
// `requiresRestart` is part of the contract, not a footnote: the kernel discovers cubes at
// startup, so writing the directory does not mount it. It is carried through to the screen
// rather than swallowed here -- a page that showed the new routes as live would be lying.

export type PackageInfo = {
  name: string
  kind: "cube" | "plugin"
  summary: string
  /** For a plugin, the cubes it brings; for a cube, itself. */
  cubes: Array<string>
  installed: boolean
  bytes: number
}

export type InstallResult = { package: PackageInfo; requiresRestart: boolean }
export type InstallFromResult = { package: PackageInfo; staged: boolean; requiresRestart: boolean }
export type RemoveResult = { removed: string; requiresRestart: boolean }

export const packages = () => request<Array<PackageInfo>>("/settings/packages")

export const installPackage = (name: string) =>
  request<InstallResult>(`/settings/packages/${name}/install`, { method: "POST" })

/**
 * Install from a directory the administrator points at. The path is absolute on the SERVER -
 * the kernel validates, stages and copies it; the browser never touches the bytes.
 */
export const installFromDirectory = (path: string) =>
  request<InstallFromResult>(`/settings/packages/install-from`, { method: "POST", body: JSON.stringify({ path }) })

export const removeCube = (name: string) =>
  request<RemoveResult>(`/settings/cubes/${encodeURIComponent(name)}`, { method: "DELETE" })

/**
 * Undo an install by PACKAGE name -- the only way back before a restart.
 *
 * `removeCube` above takes a mounted cube, and installing does not mount. So between installing
 * something by accident and restarting, that route cannot reach it.
 */
export const uninstallPackage = (name: string) =>
  request<RemoveResult>(`/settings/packages/${name}`, { method: "DELETE" })

export type RestartResult = { restarting: boolean; message: string }
export const restartApi = () => request<RestartResult>(`/settings/restart`, { method: "POST" })

export type Me = { id: string; username: string; roles: Array<string>; permissions: Array<string> }
export const me = () => request<Me>("/auth/me")

/**
 * Every route the server declares, as `METHOD /path`.
 *
 * Worth knowing before reading it as truth: the OpenAPI document is composed at STARTUP from the
 * cubes that were on disk then. Switching a cube off does not shorten it -- the routes stay in the
 * document and answer 404 at runtime. Measured, not assumed.
 */
export const routes = async (): Promise<Array<string>> => {
  const doc = await request<{ paths?: Record<string, Record<string, unknown>> }>("/openapi.json")
  return Object.entries(doc.paths ?? {})
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`))
    .sort()
}

export const list = (cube: string, offset = 0, limit = 10) =>
  request<Paged<Record<string, unknown>>>(`/${cube}?offset=${offset}&limit=${limit}`)

export const one = (cube: string, id: string) => request<Record<string, unknown>>(`/${cube}/${id}`)

/** The leaf of a compound cube name (`booktags/bookmarks` -> `bookmarks`); bare names pass
 *  through. The ONE place the split lives in this app -- mirrors the kernel's `leafOf`. */
export const leafName = (full: string): string => (full.includes("/") ? (full.split("/")[1] as string) : full)

/** The web route for a cube screen: standalone cubes at `/<name>`, children grouped under
 *  their parent at `/<parent>/<child>` -- one sidebar entry per hierarchy. */
export const screenPath = (c: CubeInfo): string => (c.parent ? `/${c.parent}/${leafName(c.name)}` : `/${c.name}`)

export type LinksFor = {
  entity: string
  id: string
  parents: Array<{ field: string; to: string; summary: Summary | null }>
  groups: Array<{ cube: string; label: string; field: string; total: number }>
}

export const linksFor = (entity: string, id: string) => request<LinksFor>(`/links/${entity}/${id}`)
export const linkGroup = (entity: string, id: string, cube: string, offset = 0, limit = 5) =>
  request<Paged<Summary>>(`/links/${entity}/${id}/${cube}?offset=${offset}&limit=${limit}`)

export type Command = { name: string; summary: string; permission: string; allowed: boolean }
export const commands = () => request<Array<Command>>("/cli/commands")
export const exec = (line: string) =>
  request<{ command: string; output: string; ok: boolean }>("/cli/exec", {
    method: "POST",
    body: JSON.stringify({ line }),
  })
