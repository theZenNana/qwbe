// The only thing this frontend knows about the backend: its address.
//
// There is no generated client and no type imported from the API. The contract is composed at
// runtime from whatever cubes are on disk, so a static client would either be wrong or would
// force the cube list back into code. What the frontend uses instead is the catalogue: names,
// shapes, links, commands. A new cube -- or a whole plugin -- appears without a rebuild here.

import { Schema } from "effect"
import type {
  AgentContext,
  AgentGoalResult,
  AgentHealth,
  AgentTrace,
  Command,
  CubeInfo,
  InstallFromResult,
  InstallResult,
  LinksFor,
  Me,
  PackageInfo,
  Paged,
  RemoveResult,
  RestartResult,
  Summary,
} from "./contracts.ts"
import {
  AgentContextSchema,
  AgentGoalResultSchema,
  AgentHealthSchema,
  AgentTraceSchema,
  CommandResultSchema,
  CommandSchema,
  CubeInfoSchema,
  InstallFromResultSchema,
  InstallResultSchema,
  LinksForSchema,
  MeSchema,
  OkSchema,
  OpenApiDocumentSchema,
  PackageInfoSchema,
  PagedSchema,
  RemoveResultSchema,
  RestartResultSchema,
  SessionTokenSchema,
  SummarySchema,
  UnknownRowSchema,
} from "./contracts.ts"
import { endSession, session } from "./session.ts"

export type {
  AgentContext,
  AgentGoalResult,
  AgentHealth,
  AgentTrace,
  Command,
  CubeInfo,
  InstallFromResult,
  InstallResult,
  LinksFor,
  Me,
  PackageInfo,
  Paged,
  RemoveResult,
  RestartResult,
  Summary,
}

export const BASE = process.env.NEXT_PUBLIC_QWBE_API ?? "http://127.0.0.1:4500"
export const apiUrl = (path: string): string => `${BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const request = async <A, I>(
  path: string,
  schema: Schema.Schema<A, I, never>,
  options: RequestInit = {},
): Promise<A> => {
  const r = await fetch(apiUrl(path), {
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
  return Schema.decodeUnknownPromise(schema)(body)
}

export const login = async (username: string, password: string) => {
  const r = await request("/auth/login", SessionTokenSchema, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  })
  session.write(r)
  return r
}

export const logout = async () => {
  await request("/auth/logout", OkSchema, { method: "POST" }).catch(() => undefined)
  session.clear()
}

export const catalogue = async () => [...(await request("/settings/cubes", Schema.Array(CubeInfoSchema)))]
export const toggleCube = (name: string, enabled: boolean) =>
  request(`/settings/cubes/${encodeURIComponent(name)}`, CubeInfoSchema, {
    method: "POST",
    body: JSON.stringify({ enabled }),
  })

// --- installing -------------------------------------------------------------------------------
//
// `requiresRestart` is part of the contract, not a footnote: the kernel discovers cubes at
// startup, so writing the directory does not mount it. It is carried through to the screen
// rather than swallowed here -- a page that showed the new routes as live would be lying.

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

export const removeCube = (name: string) =>
  request(`/settings/cubes/${encodeURIComponent(name)}`, RemoveResultSchema, { method: "DELETE" })

/**
 * Undo an install by PACKAGE name -- the only way back before a restart.
 *
 * `removeCube` above takes a mounted cube, and installing does not mount. So between installing
 * something by accident and restarting, that route cannot reach it.
 */
export const uninstallPackage = (name: string) =>
  request(`/settings/packages/${name}`, RemoveResultSchema, { method: "DELETE" })

export const restartApi = () => request(`/settings/restart`, RestartResultSchema, { method: "POST" })

export const me = () => request("/auth/me", MeSchema)

/**
 * Every route the server declares, as `METHOD /path`.
 *
 * Worth knowing before reading it as truth: the OpenAPI document is composed at STARTUP from the
 * cubes that were on disk then. Switching a cube off does not shorten it -- the routes stay in the
 * document and answer 404 at runtime. Measured, not assumed.
 */
export const routes = async (): Promise<Array<string>> => {
  const doc = await request("/openapi.json", OpenApiDocumentSchema)
  return Object.entries(doc.paths ?? {})
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method.toUpperCase()} ${path}`))
    .sort()
}

export const list = (cube: string, offset = 0, limit = 10) =>
  request(`/${cube}?offset=${offset}&limit=${limit}`, PagedSchema(UnknownRowSchema))

export const one = (cube: string, id: string) => request(`/${cube}/${id}`, UnknownRowSchema)

/** The leaf of a compound cube name (`booktags/bookmarks` -> `bookmarks`); bare names pass
 *  through. The ONE place the split lives in this app -- mirrors the kernel's `leafOf`. */
export const leafName = (full: string): string => (full.includes("/") ? (full.split("/")[1] as string) : full)

/** The web route for a cube screen: standalone cubes at `/<name>`, children grouped under
 *  their parent at `/<parent>/<child>` -- one sidebar entry per hierarchy. */
export const screenPath = (c: CubeInfo): string => (c.parent ? `/${c.parent}/${leafName(c.name)}` : `/${c.name}`)

/** Agent browser routes keep compound identity; requests use the real mounted prefix. */
export const agentScreenPath = (c: Pick<CubeInfo, "name">): string => `/agent/${c.name}`
export const agentApiPrefix = (c: Pick<CubeInfo, "name" | "prefix">): string => c.prefix ?? leafName(c.name)

export const linksFor = (entity: string, id: string) => request(`/links/${entity}/${id}`, LinksForSchema)
export const linkGroup = (entity: string, id: string, cube: string, offset = 0, limit = 5) =>
  request(
    `/links/${entity}/${id}/${encodeURIComponent(cube)}?offset=${offset}&limit=${limit}`,
    PagedSchema(SummarySchema),
  )

export const commands = async () => [...(await request("/cli/commands", Schema.Array(CommandSchema)))]
export const exec = (line: string) =>
  request("/cli/exec", CommandResultSchema, {
    method: "POST",
    body: JSON.stringify({ line }),
  })

const agentPath = (cube: string, suffix: string) => `/${encodeURIComponent(cube)}/${suffix}`
export const agentHealth = (cube: string) => request(agentPath(cube, "health"), AgentHealthSchema)
export const agentContext = (cube: string) => request(agentPath(cube, "context"), AgentContextSchema)
export const runAgentGoal = (cube: string, goal: string) =>
  request(agentPath(cube, "goals"), AgentGoalResultSchema, { method: "POST", body: JSON.stringify({ goal }) })
export const agentTrace = (cube: string) => request(agentPath(cube, "trace"), AgentTraceSchema)
