// The only audited type-erasure adapter.
// Runtime discovery makes the concrete union of HttpApi groups unknowable to TypeScript. Every
// cube is fully typed and runtime-validated before this seam; no erased value leaves it.
//
// QWB-46 (custom-field values live in the row): this seam also carries the one kernel policy
// that makes that storage possible. A cube's static payload schema strips every key it does not
// declare -- measured on 30 Aug 2026: `POST /contacts {"lastName":"Test","cnp":"123"}` answered
// 200 and stored no `cnp`. Instead of losing those keys, this module widens every struct-shaped
// payload and success schema with an index signature (the declared fields keep their
// validation), and the handler wrapper moves the keys the payload schema did NOT declare into
// one reserved sub-object of the row body: `CUSTOM` (`custom`). The target cube's own store
// operations persist it -- `body` is jsonb under a GIN index (ADR-0001 sections 3-4), so the
// values are queryable without a migration and without a sidecar table.
//
// Deliberately narrow:
//   - only TypeLiteral (struct) schemas are widened; anything else passes through untouched;
//   - declared fields are never moved -- their validation is unchanged;
//   - a list response wraps only its top-level page struct, so detail views show custom fields
//     and list rows do not. Widening a nested `rows` element schema for every page shape was
//     not worth the AST surgery; the detail endpoint is the read path custom fields need.

import { HttpApi, HttpApiBuilder, OpenApi } from "@effect/platform"
import { Layer, Option, Schema } from "effect"
import * as AST from "effect/SchemaAST"
import type { MountedCube } from "./kernel/discovery.ts"

/** The reserved sub-object of a row body where undeclared keys are kept. One name, everywhere. */
export const CUSTOM = "custom"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Widen a struct schema with a string-keyed index signature over `unknown`.
 *
 * Effect strips undeclared properties on decode; the index signature makes them declared
 * instead, so they survive both decode (payload in) and encode (row out) while every declared
 * property keeps its own validation. Rebuilt from the ORIGINAL AST -- property signatures are
 * reused as-is, so refinements inside fields are untouched. Non-struct schemas pass through.
 */
export const widenStruct = (schema: unknown): unknown => {
  if (!isSchemaLike(schema)) return schema
  const ast = (schema as { ast: AST.AST }).ast
  // A plain Struct widens directly. A Struct carrying `optionalWith` defaults is a
  // Transformation (encoded <-> type): both sides are widened and the original per-field
  // transformation is kept, so defaults keep applying on decode.
  if (ast instanceof AST.TypeLiteral) return Schema.make(widenTypeLiteral(ast))
  if (ast instanceof AST.Transformation) {
    const from = widenTypeLiteral(ast.from as AST.TypeLiteral)
    const to = widenTypeLiteral(ast.to as AST.TypeLiteral)
    return Schema.make(new AST.Transformation(from, to, ast.transformation))
  }
  return schema
}

const widenTypeLiteral = (ast: AST.TypeLiteral): AST.TypeLiteral => {
  const idx = new AST.IndexSignature(new AST.StringKeyword(), new AST.UnknownKeyword(), true)
  return new AST.TypeLiteral(ast.propertySignatures, [...ast.indexSignatures, idx])
}

const isSchemaLike = (schema: unknown): schema is { readonly ast: AST.AST } =>
  !!schema && (typeof schema === "object" || typeof schema === "function") && "ast" in schema

/** The property names a schema declares -- the keys that must never be treated as custom. */
export const declaredKeys = (schema: unknown): ReadonlyArray<string> => {
  if (!isSchemaLike(schema)) return []
  const ast = (schema as { ast: AST.AST }).ast
  // A Struct with defaults is a Transformation; the declared names live on both sides -- the
  // type side is the one the widened decode produces.
  const literal = ast instanceof AST.Transformation ? ast.to : ast
  if (!(literal instanceof AST.TypeLiteral)) return []
  return literal.propertySignatures.map((p) => String(p.name))
}

/**
 * Move every undeclared key of a decoded payload into `payload.custom`, merging with any
 * `custom` object the caller sent explicitly. Declared keys stay exactly where they are.
 */
export const foldCustom = (payload: unknown, declared: ReadonlyArray<string>): unknown => {
  if (!isRecord(payload)) return payload
  const known = new Set(declared)
  const custom: Record<string, unknown> = {
    ...(isRecord(payload[CUSTOM]) ? payload[CUSTOM] : {}),
  }
  let moved = false
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key === CUSTOM) {
      moved = true
      continue
    }
    if (known.has(key)) {
      kept[key] = value
      continue
    }
    custom[key] = value
    moved = true
  }
  if (!moved) return payload
  return { ...kept, [CUSTOM]: custom }
}

export const buildApi = (cubes: ReadonlyArray<MountedCube>): HttpApi.HttpApi<"cubes", never, never, never> => {
  const empty = HttpApi.make("cubes")
    .annotate(OpenApi.Title, "Qwbe -- kernel plus cubes discovered from disk")
    .annotate(
      OpenApi.Description,
      "One cube = one directory. Installing it touches no existing file. Plugins land in the same namespace.",
    )

  // Widen in place BEFORE the api is built: the OpenAPI spec, the server-side payload decode
  // and the response encode all read these same endpoint objects, so the spec documents the
  // `custom` tolerance the server actually has.
  for (const cube of cubes) {
    const group = cube.parts.group as {
      endpoints?: Record<string, { payloadSchema?: Option.Option<unknown>; successSchema?: Option.Option<unknown> }>
    }
    for (const endpoint of Object.values(group.endpoints ?? {})) {
      if (!endpoint || typeof endpoint !== "object") continue
      const e = endpoint as Record<string, unknown>
      for (const key of ["payloadSchema", "successSchema"] as const) {
        const value = e[key] as Option.Option<unknown>
        // Most endpoints carry these as Options; some store the bare schema. Both are widened
        // in place, whichever shape they come in: a non-Option schema fails the isSome check
        // and goes through the schema-like branch below.
        if (Option.isSome(value)) {
          e[key] = Option.some(widenStruct(value.value))
        } else if (isSchemaLike(value)) {
          e[key] = widenStruct(value)
        }
      }
    }
  }

  return cubes.reduce<any>((api, cube) => api.add(cube.parts.group), empty)
}

export const buildHandlers = (api: unknown, cubes: ReadonlyArray<MountedCube>): Layer.Layer<never, never, never> => {
  const layers = cubes.map((cube) => {
    const id = cube.parts.group.identifier
    return HttpApiBuilder.group(api as any, id as never, (handlers: any) =>
      Object.entries(cube.parts.handlers).reduce(
        (current, [name, implementation]) => current.handle(name, withCustomFold(api, id, name, implementation)),
        handlers,
      ),
    )
  })
  const [first, ...rest] = layers

  return (first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest)) as any
}

/**
 * Wrap one handler so undeclared payload keys reach it folded under `custom`. The declared keys
 * come from the WIDENED payload schema in the api -- its property signatures are the original
 * ones, so the fold never touches a field the cube declared.
 */
const withCustomFold = (api: unknown, groupId: unknown, name: string, implementation: unknown) => {
  const groups = (
    api as { groups?: Record<string, { endpoints?: Record<string, { payloadSchema?: Option.Option<unknown> }> }> }
  ).groups
  const group = groups
    ? Object.values(groups).find((g) => (g as { identifier?: unknown }).identifier === groupId)
    : undefined
  const payloadSchema = group?.endpoints?.[name]?.payloadSchema
  if (!payloadSchema || !Option.isSome(payloadSchema)) return implementation
  const declared = declaredKeys(payloadSchema.value)
  const impl = implementation as (request: unknown) => unknown
  return (request: unknown) => {
    if (isRecord(request) && "payload" in request) {
      return impl({ ...request, payload: foldCustom(request.payload, declared) })
    }
    return impl(request)
  }
}
