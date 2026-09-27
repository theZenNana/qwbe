// The generic probes -- the checks a package cannot write, dodge or
// weaken, because nothing in the package composes them. Derived from what the package
// DECLARES (its cubes' manifests, dumped by `check-manifests.ts`) and from the metadata the
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

import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { Command, FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { Effect, Either, Option, Schema, Stream } from "effect"
import { type CallOptions, call, sessionToken } from "./api-client.ts"
import type { PackageFinding } from "./package-finding.ts"

// --- shapes ---------------------------------------------------------------------------------

/** The raw declarations of one cube, as `check-manifests.ts` reports them. */
const PackDeclarations = Schema.Struct({
  searchable: Schema.optional(Schema.Unknown),
  relations: Schema.optional(Schema.Unknown),
})
type PackDeclarations = typeof PackDeclarations.Type

/** What the dump wrote: per-cube declarations, plus per-cube import errors. */
const DeclarationsDump = Schema.Struct({
  cubes: Schema.optional(Schema.Record({ key: Schema.String, value: PackDeclarations })),
  errors: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
export type DeclarationsDump = typeof DeclarationsDump.Type

type GenericProbeReport = {
  /** Findings are failures only: a check that ran and saw what the contract promises is silence. */
  readonly findings: PackageFinding[]
  /** How many assertions actually ran -- the number the check's output shows. */
  readonly checks: number
}

const PublishedField = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  required: Schema.Boolean,
  editable: Schema.Boolean,
  nullable: Schema.Boolean,
  enum: Schema.NullOr(Schema.Array(Schema.String)),
  custom: Schema.Boolean,
})

/** The part of the published CubeMetadata the probes need. Read over HTTP, never derived
 *  here: the probes must judge the metadata the kernel REALLY serves, not a second derivation. */
const PublishedMetadata = Schema.Struct({
  cube: Schema.String,
  fields: Schema.optional(Schema.Array(PublishedField)),
  routes: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        auth: Schema.Boolean,
        permission: Schema.NullOr(Schema.String),
        method: Schema.String,
        path: Schema.String,
      }),
    }),
  ),
})
type PublishedMetadata = typeof PublishedMetadata.Type
type Route = { readonly method: string; readonly path: string }

const CatalogEntry = Schema.Struct({ name: Schema.String })
const Listed = Schema.Struct({ total: Schema.Unknown })
const RelationTarget = Schema.Struct({ target: Schema.NonEmptyString })

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
  for (const [field, spec] of Object.entries(relations)) {
    count()
    if (!Schema.is(RelationTarget)(spec)) {
      fail("relation-target", file, `relation ${field} declares no target cube`)
      continue
    }
    if (!catalog.has(spec.target)) {
      fail(
        "relation-target",
        file,
        `relation ${field} points at cube "${spec.target}", which does not exist in the catalog`,
      )
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

export const runGenericProbes = (input: GenericProbeInput) =>
  Effect.gen(function* () {
    const findings: PackageFinding[] = []
    let checks = 0
    const base = input.url.replace(/\/$/, "")

    const request = (path: string, options: CallOptions = {}) => call(base, path, options)

    const fail = (rule: string, file: string, message: string): void => {
      findings.push({ rule, file, message })
    }

    const login = (username: string, password: string) =>
      Effect.map(request("/auth/login", { method: "POST", body: { username, password } }), ({ body }) =>
        Option.getOrNull(sessionToken(body)),
      )

    const admin = yield* login("admin", input.adminPassword)
    if (!admin) {
      const report: GenericProbeReport = {
        checks: 0,
        findings: [
          {
            rule: "generic-probes",
            file: "qwbe-package.json",
            message: "could not log in as admin on the sandbox kernel -- the generic probes cannot run",
          },
        ],
      }
      return report
    }

    // A token that authenticates but carries NO permission: the 403 probe's instrument. The
    // account cube is a required system cube, so it is there in every sandbox.
    let noPerms: string | null = null
    const probeUser = `qwbe-check-${randomToken()}`
    const probePassword = `pw-${randomToken()}`
    const created = yield* request("/account", {
      method: "POST",
      token: admin,
      body: { username: probeUser, password: probePassword, roles: [] },
    })
    if (created.status < 200 || created.status >= 300) {
      fail(
        "generic-probes",
        "qwbe-package.json",
        `could not create a permissionless user (status ${created.status}): ${excerpt(created.body)} -- 403 checks are skipped`,
      )
    } else {
      noPerms = yield* login(probeUser, probePassword)
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
    const cubes = yield* request("/settings/cubes", { token: admin })
    if (cubes.status === 200 && Array.isArray(cubes.body)) {
      for (const entry of cubes.body) {
        if (Schema.is(CatalogEntry)(entry)) catalog.add(entry.name)
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
      return r && r.path.length > 0 ? r : null
    }
    const requestRoute = (route: Route, body?: unknown, token?: string) =>
      request(fillPath(route.path), {
        method: route.method as NonNullable<CallOptions["method"]>,
        ...(body === undefined ? {} : { body }),
        ...(token === undefined ? {} : { token }),
      })

    // null: the cube publishes no metadata. A 200 that does not decode is the kernel breaking its
    // own contract -- a finding, not a skip.
    const metadataOf = (cube: string, file: string) =>
      Effect.map(request(`/catalog/${encodeURIComponent(cube)}/metadata`, { token: admin }), (r) => {
        if (r.status !== 200) return null
        const md = Schema.decodeUnknownEither(PublishedMetadata)(r.body)
        if (Either.isRight(md)) return md.right
        fail("generic-probes", file, `the published metadata does not decode: ${md.left.message}`)
        return null
      })

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
      const md = yield* metadataOf(cube, file)
      if (!md) {
        yield* Effect.logInfo(
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
        const unauthenticated = yield* requestRoute(route, body)
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
          const forbidden = yield* requestRoute(route, body, noPerms)
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
        yield* Effect.logInfo(
          `  generic probes: ${cube} declares no create route -- the required family does not apply`,
        )
      } else if (required.length > 0) {
        const salt = randomToken()
        const payload = createPayload(fieldsOf(md), salt)
        const baseline = yield* requestRoute(createRoute, payload, admin)
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
            const r = yield* requestRoute(createRoute, without, admin)
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
          yield* Effect.logInfo(
            `  generic probes: ${cube} declares searchable fields but no list route -- the searchable family does not apply`,
          )
      } else if (!createRoute) {
        yield* Effect.logInfo(
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
            yield* Effect.logInfo(
              `  generic probes: ${cube}.${field} is ${meta.editable ? "not a string" : "not caller-settable"} -- the probe cannot manufacture rows for it, skipping`,
            )
            continue
          }
          const a = `qwbe-probe-${randomToken()}-a`
          const b = `qwbe-probe-${randomToken()}-b`
          const payload = createPayload(fieldsOf(md), randomToken())
          const first = yield* requestRoute(createRoute, { ...payload, [field]: a }, admin)
          const second = yield* requestRoute(createRoute, { ...payload, [field]: b }, admin)
          if (first.status < 200 || first.status >= 300 || second.status < 200 || second.status >= 300) {
            fail(
              "searchable",
              file,
              `could not create the two rows the searchable probe needs (statuses ${first.status}, ${second.status}): ${excerpt(first.body)}`,
            )
            continue
          }
          const filtered = yield* request(
            `${fillPath(listRoute.path)}?${encodeURIComponent(field)}=${encodeURIComponent(a)}`,
            { token: admin },
          )
          checks++
          const total = Schema.is(Listed)(filtered.body) ? filtered.body.total : undefined
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

    const report: GenericProbeReport = { findings, checks }
    return report
  })

// --- the stage check-package.ts runs -----------------------------------------------------------

type GenericStageOptions = {
  readonly dir: string
  readonly cubes: ReadonlyArray<string>
  readonly url: string
  readonly adminPassword: string
  /** Node flags for the dump, e.g. `--conditions=qwbe-dist`; empty for a checkout. */
  readonly conditions: ReadonlyArray<string>
  /** The declarations dump the kernel runs: src/check-manifests.ts, or its dist/ build. */
  readonly dumpScript: string
}

const text = (stream: Stream.Stream<Uint8Array, PlatformError>) => stream.pipe(Stream.decodeText(), Stream.mkString)

const nothingToProbe = (): GenericProbeReport => ({ findings: [], checks: 0 })

const declarationsFailure = (message: string): GenericProbeReport => ({
  checks: 0,
  findings: [{ rule: "declarations", file: "cubes/", message }],
})

/**
 * Dump the package's raw declarations, then run the probes against the booted kernel. The
 * dump failure is a finding, never a silent skip: a check that could not read what the
 * package declares must not report green.
 */
export const runGenericStage = (options: GenericStageOptions) =>
  Effect.gen(function* () {
    if (options.cubes.length === 0) return nothingToProbe()
    const fs = yield* FileSystem.FileSystem
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "qwbe-declarations-" })
    const outPath = join(scratch, "declarations.json")
    const dump = Command.make(process.execPath, ...options.conditions, options.dumpScript).pipe(
      Command.workingDirectory(options.dir),
      Command.env({
        QWBE_PACK_DIR: options.dir,
        QWBE_PACK_CUBES: JSON.stringify(options.cubes),
        QWBE_DECLARATIONS_OUT: outPath,
      }),
    )
    const run = yield* Effect.flatMap(Command.start(dump), (proc) =>
      Effect.all(
        {
          exit: proc.exitCode.pipe(
            Effect.map((code): number | null => code),
            Effect.orElseSucceed(() => null),
          ),
          stdout: text(proc.stdout),
          stderr: text(proc.stderr),
        },
        { concurrency: "unbounded" },
      ),
    )
    if (run.exit !== 0) {
      return declarationsFailure(
        `the generic probes could not read the package's declarations (dump exit ${run.exit}): ${excerpt(run.stderr || run.stdout)}`,
      )
    }
    const read = yield* Effect.either(
      Effect.flatMap(fs.readFileString(outPath), Schema.decodeUnknown(Schema.parseJson(DeclarationsDump))),
    )
    if (Either.isLeft(read)) {
      return declarationsFailure(`the declarations dump is not readable JSON: ${read.left.message}`)
    }
    const dumped = read.right
    const report = yield* runGenericProbes({
      url: options.url,
      adminPassword: options.adminPassword,
      cubes: options.cubes,
      declarations: dumped,
    })
    for (const [cube, error] of Object.entries(dumped.errors ?? {})) {
      report.findings.push({
        rule: "declarations",
        file: `cubes/${cube}/index.ts`,
        message: `the generic probes could not import this cube: ${error}`,
      })
    }
    return report
  }).pipe(Effect.scoped)
