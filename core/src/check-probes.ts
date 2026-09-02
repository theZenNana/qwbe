// The generic probes -- the checks a package cannot write, dodge or
// weaken, because nothing in the package composes them. Derived from what the package
// DECLARES (its cubes' manifests, dumped by `check-manifests.mjs`) and from the metadata the
// booted kernel publishes, then run against that same kernel:
//
//   1. routes      every route the metadata publishes answers 401 without a token, and 403
//                  with a token that lacks the declared permission -- a permission declared in
//                  the manifest but never enforced in a handler cannot survive this.
//   2. searchable  every declared searchable field: two rows plus a filter = exactly one row.
//   3. required    every required field: missing at create = 400.
//   4. relations   every declared `relations[].target` exists in the catalog.
//
// The library returns data; check-package.ts decides the verdict. All state the probes create
// (rows, a user) lives in the check's throwaway sandbox database.

import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PackageFinding } from "./package-contract-scan.ts"

// --- shapes ---------------------------------------------------------------------------------

/** The raw declarations of one cube, as `check-manifests.mjs` reports them. */
type PackDeclarations = {
  readonly searchable?: unknown
  readonly relations?: unknown
}

/** What the dump wrote: per-cube declarations, plus per-cube import errors. */
export type DeclarationsDump = {
  readonly cubes?: Readonly<Record<string, PackDeclarations>>
  readonly errors?: Readonly<Record<string, string>>
}

type GenericProbeReport = {
  /** Findings are failures only: a check that ran and saw what the contract promises is silence. */
  readonly findings: PackageFinding[]
  /** How many assertions actually ran -- the number the check's output shows. */
  readonly checks: number
}

/** Minimal view of the published CubeMetadata the probes need. Read over HTTP, never derived
 *  here: the probes must judge the metadata the kernel REALLY serves, not a second derivation. */
type PublishedMetadata = {
  readonly cube: string
  readonly fields?: ReadonlyArray<{
    readonly name: string
    readonly type: string
    readonly required: boolean
    readonly editable: boolean
    readonly nullable: boolean
    readonly enum: ReadonlyArray<string> | null
    readonly custom: boolean
  }>
  readonly routes?: Readonly<
    Record<
      string,
      { readonly auth: boolean; readonly permission: string | null; readonly method: string; readonly path: string }
    >
  >
}

type Response = { readonly status: number; readonly body: unknown }

const excerpt = (body: unknown): string => {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const one = (text ?? "").replace(/\s+/g, " ").trim()
  return one.length > 200 ? `${one.slice(0, 200)}...` : one
}

/** Fill every `:param` of a route's path template with a placeholder that decodes as string
 *  and number alike. The auth middleware and the permission check run before a lookup, so
 *  the value never has to name a real row -- and when it does reach a handler, 404 is exactly
 *  the "not enforced" evidence the probes look for. */
export const fillPath = (template: string, value = "0"): string =>
  template.replaceAll(/:[A-Za-z_][A-Za-z0-9_]*/g, value)

// --- values a probe can build from published field metadata ----------------------------------

/** A value of the published type. `undefined` = do not send the field (unknown shape). */
export const valueFor = (
  field: { readonly type: string; readonly enum: ReadonlyArray<string> | null },
  salt: string,
): unknown => {
  if (field.enum && field.enum.length > 0) return field.enum[0]
  switch (field.type) {
    case "string":
      return `qwbe-probe-${salt}`
    case "integer":
    case "number":
      return 1
    case "boolean":
      return true
    case "array":
      return []
    default:
      return undefined
  }
}

/** A create payload holding every required, editable, non-custom field. Custom fields are
 *  runtime data, not manifest declarations -- the probes judge declarations. */
export const createPayload = (fields: PublishedMetadata["fields"], salt: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const f of fields ?? []) {
    if (!f.editable || !f.required || f.custom) continue
    const v = valueFor(f, salt)
    if (v !== undefined) out[f.name] = v
  }
  return out
}

// --- the probe itself -------------------------------------------------------------------------

const randomToken = (): string => randomBytes(4).toString("hex")

/** Family 4: every declared `relations[].target` exists in the catalog. Runs from the RAW
 *  declarations on purpose: the published metadata resolves a relation to null when its
 *  target is not mounted -- the derivation would hide exactly the lie this probe exists for. */
const probeRelations = (
  declared: PackDeclarations,
  catalog: ReadonlySet<string>,
  file: string,
  fail: (rule: string, file: string, message: string) => void,
  count: () => void,
): void => {
  const relations = declared.relations
  if (relations === undefined || relations === null) return
  if (typeof relations !== "object" || Array.isArray(relations)) {
    fail(
      "relation-target",
      file,
      `declares relations as ${JSON.stringify(relations)?.slice(0, 80)} -- the manifest shape is an object of { field: { target } }`,
    )
    return
  }
  for (const [field, spec] of Object.entries(relations as Record<string, unknown>)) {
    count()
    const target = (spec as { target?: unknown } | null)?.target
    if (typeof target !== "string" || target.length === 0) {
      fail("relation-target", file, `relation ${field} declares no target cube`)
      continue
    }
    if (!catalog.has(target)) {
      fail("relation-target", file, `relation ${field} points at cube "${target}", which does not exist in the catalog`)
    }
  }
}

type GenericProbeInput = {
  /** Kernel base URL, no trailing slash -- the sandbox the check booted. */
  readonly url: string
  readonly adminPassword: string
  readonly cubes: ReadonlyArray<string>
  readonly declarations: DeclarationsDump
}

export const runGenericProbes = async (input: GenericProbeInput): Promise<GenericProbeReport> => {
  const findings: PackageFinding[] = []
  let checks = 0
  const base = input.url.replace(/\/$/, "")

  const call = async (path: string, init: RequestInit = {}, token?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    }
    if (token) headers.authorization = `Bearer ${token}`
    const r = await fetch(`${base}${path}`, { ...init, headers })
    const text = await r.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* not JSON -- keep the text */
    }
    return { status: r.status, body }
  }

  const fail = (rule: string, file: string, message: string): void => {
    findings.push({ rule, file, message })
  }

  const login = async (username: string, password: string): Promise<string | null> => {
    const r = await call("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) })
    return typeof (r.body as { token?: unknown })?.token === "string" ? (r.body as { token: string }).token : null
  }

  const admin = await login("admin", input.adminPassword)
  if (!admin) {
    return {
      checks: 0,
      findings: [
        {
          rule: "generic-probes",
          file: "qwbe-package.json",
          message: "could not log in as admin on the sandbox kernel -- the generic probes cannot run",
        },
      ],
    }
  }

  // A token that authenticates but carries NO permission: the 403 probe's instrument. The
  // account cube is a required system cube, so it is there in every sandbox.
  let noPerms: string | null = null
  const probeUser = `qwbe-check-${randomToken()}`
  const probePassword = `pw-${randomToken()}`
  const created = await call(
    "/account",
    {
      method: "POST",
      body: JSON.stringify({ username: probeUser, password: probePassword, roles: [] }),
    },
    admin,
  )
  if (created.status < 200 || created.status >= 300) {
    fail(
      "generic-probes",
      "qwbe-package.json",
      `could not create a permissionless user (status ${created.status}): ${excerpt(created.body)} -- 403 checks are skipped`,
    )
  } else {
    noPerms = await login(probeUser, probePassword)
    if (!noPerms) {
      fail(
        "generic-probes",
        "qwbe-package.json",
        "created the probe user but could not log it in -- 403 checks are skipped",
      )
    }
  }

  // The catalog: every cube name the kernel knows. The relation probe judges targets against
  // it -- and against NOTHING the package says about itself.
  const catalog = new Set<string>()
  const cubes = await call("/settings/cubes", {}, admin)
  if (cubes.status === 200 && Array.isArray(cubes.body)) {
    for (const entry of cubes.body as Array<{ name?: unknown }>) {
      if (typeof entry?.name === "string") catalog.add(entry.name)
    }
  } else {
    fail(
      "generic-probes",
      "qwbe-package.json",
      `could not read the catalog (status ${cubes.status}): ${excerpt(cubes.body)} -- relation checks are skipped`,
    )
  }

  const routesOf = (md: PublishedMetadata) => md.routes ?? {}
  const fieldsOf = (md: PublishedMetadata) => md.fields ?? []
  const findRoute = (md: PublishedMetadata, name: string) => {
    const r = routesOf(md)[name]
    return r && typeof r.method === "string" && typeof r.path === "string" && r.path.length > 0 ? r : null
  }
  const requestRoute = (route: { method: string; path: string }, body?: unknown, token?: string) =>
    call(
      fillPath(route.path),
      {
        method: route.method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      token,
    )

  const metadataOf = async (cube: string): Promise<PublishedMetadata | null> => {
    const r = await call(`/catalog/${encodeURIComponent(cube)}/metadata`, {}, admin)
    return r.status === 200 ? (r.body as PublishedMetadata) : null
  }

  for (const cube of input.cubes) {
    const file = `cubes/${cube}/index.ts`
    const declared: PackDeclarations | undefined = input.declarations.cubes?.[cube]
    if (!declared) {
      fail(
        "declarations",
        file,
        `the generic probes have no declarations for this cube${input.declarations.errors?.[cube] ? `: ${input.declarations.errors[cube]}` : " -- the dump did not report it"}`,
      )
      continue
    }
    const md = await metadataOf(cube)
    if (!md) {
      console.log(
        `  generic probes: ${cube} publishes no metadata -- route, searchable and required families do not apply`,
      )
      probeRelations(declared, catalog, file, fail, () => checks++)
      continue
    }

    // --- family 1: every published route, 401 without a token, 403 without the permission ---
    for (const [name, route] of Object.entries(routesOf(md))) {
      const body = ["POST", "PUT", "PATCH"].includes(route.method.toUpperCase())
        ? createPayload(fieldsOf(md), randomToken())
        : undefined
      const unauthenticated = await requestRoute(route, body)
      checks++
      if (route.auth && unauthenticated.status !== 401) {
        fail(
          "route-auth",
          file,
          `route ${name} (${route.method} ${route.path}) declares auth but answered ${unauthenticated.status} without a token: ${excerpt(unauthenticated.body)}`,
        )
      }
      if (route.permission) {
        if (!noPerms) {
          fail(
            "route-permission",
            file,
            `route ${name} declares permission ${route.permission} but the 403 probe has no permissionless token (see the generic-probes finding above)`,
          )
          continue
        }
        const forbidden = await requestRoute(route, body, noPerms)
        checks++
        if (forbidden.status !== 403) {
          fail(
            "route-permission",
            file,
            `route ${name} (${route.method} ${route.path}) declares permission ${route.permission} but answered ${forbidden.status} for a token without it: ${excerpt(forbidden.body)}`,
          )
        }
      }
    }

    // --- family 3: every required field, missing at create = 400 (before family 2, which
    // creates its own rows and needs the same baseline payload) ---
    const createRoute = findRoute(md, "create")
    const required = fieldsOf(md).filter((f) => f.required && f.editable && !f.custom)
    if (!createRoute) {
      console.log(`  generic probes: ${cube} declares no create route -- the required family does not apply`)
    } else if (required.length > 0) {
      const salt = randomToken()
      const payload = createPayload(fieldsOf(md), salt)
      const baseline = await requestRoute(createRoute, payload, admin)
      if (baseline.status < 200 || baseline.status >= 300) {
        fail(
          "required-field",
          file,
          `a create with every required field set answered ${baseline.status} -- the metadata cannot be turned into a row, so the required contract is not judgeable: ${excerpt(baseline.body)}`,
        )
      } else {
        for (const f of required) {
          const without = { ...payload }
          delete without[f.name]
          const r = await requestRoute(createRoute, without, admin)
          checks++
          if (r.status !== 400) {
            fail(
              "required-field",
              file,
              `field ${f.name} is required by the create contract but missing at create answered ${r.status}: ${excerpt(r.body)}`,
            )
          }
        }
      }
    }

    // --- family 2: every declared searchable field, two rows plus a filter = exactly one ---
    const listRoute = findRoute(md, "list")
    const searchable = Array.isArray(declared.searchable)
      ? declared.searchable.filter((s): s is string => typeof s === "string")
      : []
    if (!listRoute) {
      if (searchable.length > 0)
        console.log(
          `  generic probes: ${cube} declares searchable fields but no list route -- the searchable family does not apply`,
        )
    } else if (!createRoute) {
      console.log(
        `  generic probes: ${cube} declares searchable fields but no create route -- the probe cannot manufacture rows, skipping`,
      )
    } else {
      for (const field of searchable) {
        const meta = fieldsOf(md).find((f) => f.name === field)
        if (!meta) {
          checks++
          fail("searchable", file, `declares searchable field "${field}" but the cube publishes no such field`)
          continue
        }
        if (meta.type !== "string" || !meta.editable) {
          console.log(
            `  generic probes: ${cube}.${field} is ${meta.editable ? "not a string" : "not caller-settable"} -- the probe cannot manufacture rows for it, skipping`,
          )
          continue
        }
        const a = `qwbe-probe-${randomToken()}-a`
        const b = `qwbe-probe-${randomToken()}-b`
        const payload = createPayload(fieldsOf(md), randomToken())
        const first = await requestRoute(createRoute, { ...payload, [field]: a }, admin)
        const second = await requestRoute(createRoute, { ...payload, [field]: b }, admin)
        if (first.status < 200 || first.status >= 300 || second.status < 200 || second.status >= 300) {
          fail(
            "searchable",
            file,
            `could not create the two rows the searchable probe needs (statuses ${first.status}, ${second.status}): ${excerpt(first.body)}`,
          )
          continue
        }
        const filtered = await call(
          `${fillPath(listRoute.path)}?${encodeURIComponent(field)}=${encodeURIComponent(a)}`,
          {},
          admin,
        )
        checks++
        const total = (filtered.body as { total?: unknown })?.total
        if (filtered.status !== 200 || total !== 1) {
          fail(
            "searchable",
            file,
            `declares searchable field "${field}": two rows plus the filter ${field}=${a} must answer exactly one row, got status ${filtered.status} total ${JSON.stringify(total)}`,
          )
        }
      }
    }

    probeRelations(declared, catalog, file, fail, () => checks++)
  }

  return { findings, checks }
}

// --- the stage check-package.ts runs -----------------------------------------------------------

type GenericStageOptions = {
  readonly dir: string
  readonly cubes: ReadonlyArray<string>
  readonly url: string
  readonly adminPassword: string
  /** Node flags for the dump, e.g. `--conditions=qwbe-dist`; empty for a checkout. */
  readonly conditions: ReadonlyArray<string>
  /** The qwbe-core root carrying src/check-manifests.mjs. */
  readonly kernelRoot: string
}

/**
 * Dump the package's raw declarations, then run the probes against the booted kernel. The
 * dump failure is a finding, never a silent skip: a check that could not read what the
 * package declares must not report green.
 */
export const runGenericStage = async (options: GenericStageOptions): Promise<GenericProbeReport> => {
  if (options.cubes.length === 0) return { findings: [], checks: 0 }
  const scratch = mkdtempSync(join(tmpdir(), "qwbe-declarations-"))
  try {
    const outPath = join(scratch, "declarations.json")
    const r = spawnSync(
      process.execPath,
      [...options.conditions, join(options.kernelRoot, "src", "check-manifests.mjs")],
      {
        cwd: options.dir,
        env: {
          ...process.env,
          QWBE_PACK_DIR: options.dir,
          QWBE_PACK_CUBES: JSON.stringify(options.cubes),
          QWBE_DECLARATIONS_OUT: outPath,
        },
        encoding: "utf8",
      },
    )
    if (r.status !== 0) {
      return {
        checks: 0,
        findings: [
          {
            rule: "declarations",
            file: "cubes/",
            message: `the generic probes could not read the package's declarations (dump exit ${r.status}): ${excerpt(r.stderr || r.stdout)}`,
          },
        ],
      }
    }
    let dump: DeclarationsDump
    try {
      dump = JSON.parse(readFileSync(outPath, "utf8")) as DeclarationsDump
    } catch (e) {
      return {
        checks: 0,
        findings: [
          { rule: "declarations", file: "cubes/", message: `the declarations dump is not readable JSON: ${String(e)}` },
        ],
      }
    }
    const report = await runGenericProbes({
      url: options.url,
      adminPassword: options.adminPassword,
      cubes: options.cubes,
      declarations: dump,
    })
    for (const [cube, error] of Object.entries(dump.errors ?? {})) {
      report.findings.push({
        rule: "declarations",
        file: `cubes/${cube}/index.ts`,
        message: `the generic probes could not import this cube: ${error}`,
      })
    }
    return report
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
