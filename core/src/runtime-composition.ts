// The only audited type-erasure adapter.
// Runtime discovery makes the concrete union of HttpApi groups unknowable to TypeScript. Every
// cube is fully typed and runtime-validated before this seam; no erased value leaves it.
//
// QWB-46 (custom-field values live in the row): this seam also carries the one kernel policy
// that makes that storage possible. A cube's static payload schema strips every key it does not
// declare -- measured on 30 Aug 2026: `POST /contacts {"lastName":"Test","cnp":"123"}` answered
// 200 and stored no `cnp`. Instead of losing those keys, this module widens struct-shaped
// schemas and the handler wrapper folds the keys the payload schema did NOT declare into one
// reserved sub-object of the row body: `custom`. The VALUE policy itself -- the definition gate,
// the per-type validation, the size caps -- lives in `custom-values.ts`; this module only wires
// it: the fold runs against the cube's ACTIVE definitions, read at request time, so a cube with
// no defined custom fields keeps exactly its pre-QWB-46 behavior (undeclared keys stripped) and
// no holder of a plain `<cube>:write` permission can store anything without a definition.
//
// Deliberately narrow:
//   - only TypeLiteral (struct) schemas are widened; anything else passes through untouched and
//     its handlers skip the fold entirely (a schema this module did not widen has no contract
//     with the fold, and handing it an empty payload would be silent data loss);
//   - declared fields are never moved -- their validation is unchanged;
//   - the SUCCESS schema is widened with one DECLARED `custom` property, not an open index
//     signature: responses emit undeclared keys only under `custom`, so the reserved-sub-object
//     invariant holds on the read side too and the response stripping `publicShape` backs up
//     stays in place system-wide. On a LIST endpoint the success is the envelope `{rows, ...}`,
//     so the widening also reaches the row schema inside `rows` -- declared only on the
//     envelope, Effect strips the values from every row and the list answer would never carry
//     them (QWB-54 ticket 16).

import { HttpApi, HttpApiBuilder, OpenApi } from "@effect/platform"
import { Effect, Layer, Option, Schema } from "effect"
import * as AST from "effect/SchemaAST"
import { withCustomFold as withCustomFoldPolicy } from "./custom-fold.ts"
import { CUSTOM } from "./custom-values.ts"
import type { Handler } from "./entity-contract.ts"
import { declaredPermission, requirePermission } from "./kernel/auth-contract.ts"
import type { MountedCube } from "./kernel/discovery.ts"

/**
 * Widen a struct schema. `payload` schemas get a string-keyed index signature over `unknown`,
 * so undeclared keys survive decode and the fold can see them; `success` schemas get one
 * DECLARED optional `custom` property instead, so responses cannot emit undeclared keys flat.
 *
 * Effect strips undeclared properties on decode; the index signature makes them declared
 * instead, so they survive decode (payload in) while every declared property keeps its own
 * validation. Rebuilt from the ORIGINAL AST -- property signatures are reused as-is, so
 * refinements inside fields are untouched. Non-struct schemas pass through.
 */
export const widenStruct = (schema: unknown, mode: "payload" | "success"): unknown => {
  if (!isSchemaLike(schema)) return schema
  const ast = (schema as { ast: AST.AST }).ast
  // A plain Struct widens directly. A Struct carrying `optionalWith` defaults is a
  // Transformation (encoded <-> type): both sides are widened and the original per-field
  // transformation is kept, so defaults keep applying on decode.
  if (ast instanceof AST.TypeLiteral) return Schema.make(widenTypeLiteral(ast, mode))
  if (ast instanceof AST.Transformation) {
    const from = widenTypeLiteral(ast.from as AST.TypeLiteral, mode)
    const to = widenTypeLiteral(ast.to as AST.TypeLiteral, mode)
    return Schema.make(new AST.Transformation(from, to, ast.transformation, ast.annotations))
  }
  return schema
}

const widenTypeLiteral = (ast: AST.TypeLiteral, mode: "payload" | "success"): AST.TypeLiteral => {
  // A cube that declares a field literally named `custom` keeps it: nothing is added.
  if (ast.propertySignatures.some((p) => p.name === CUSTOM)) return ast
  if (mode === "payload") {
    const idx = new AST.IndexSignature(new AST.StringKeyword(), new AST.UnknownKeyword(), true)
    return new AST.TypeLiteral(ast.propertySignatures, [...ast.indexSignatures, idx], ast.annotations)
  }
  const custom = new AST.PropertySignature(
    CUSTOM,
    Schema.Record({ key: Schema.String, value: Schema.Unknown }).ast,
    true,
    true,
  )
  // The envelope's own `custom` AND the rows' -- a list response is the envelope, and the
  // values ride on the rows inside it.
  const properties = ast.propertySignatures.map(widenRowsProperty)
  return new AST.TypeLiteral([...properties, custom], ast.indexSignatures, ast.annotations)
}

/**
 * Widen the element schema of the rows array in a success envelope -- the `{rows, ...}` shape
 * `PageOf` publishes. The row rides the property as `Schema.Array(row)`: a TupleType with no
 * positional elements and one rest element wrapping the row AST. Any other property (scalars,
 * unions, tuples, refs to non-structs) passes through untouched, so only list rows are
 * affected and no other nested struct gains the declaration.
 */
const widenRowsProperty = (p: AST.PropertySignature): AST.PropertySignature => {
  if (p.name !== "rows") return p
  const array = p.type
  if (!(array instanceof AST.TupleType) || array.elements.length > 0 || array.rest.length !== 1) return p
  const element = array.rest[0]
  if (!element) return p
  const widened = widenStruct(Schema.make(element.type), "success") as { readonly ast: AST.AST }
  if (widened.ast === element.type) return p
  const widenedArray = new AST.TupleType(
    array.elements,
    [new AST.Type(widened.ast)],
    array.isReadonly,
    array.annotations,
  )
  return new AST.PropertySignature(p.name, widenedArray, p.isOptional, p.isReadonly, p.annotations)
}

const isSchemaLike = (schema: unknown): schema is { readonly ast: AST.AST } =>
  !!schema && (typeof schema === "object" || typeof schema === "function") && "ast" in schema

/** True when this module widens the schema at all: a TypeLiteral, or a Transformation between them. */
export const isStructSchema = (schema: unknown): boolean => {
  if (!isSchemaLike(schema)) return false
  const ast = (schema as { ast: AST.AST }).ast
  if (ast instanceof AST.TypeLiteral) return true
  return ast instanceof AST.Transformation && ast.to instanceof AST.TypeLiteral
}

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
        const mode = key === "payloadSchema" ? "payload" : "success"
        // Most endpoints carry these as Options; some store the bare schema. Both are widened
        // in place, whichever shape they come in.
        if (Option.isSome(value)) {
          e[key] = Option.some(widenStruct(value.value, mode))
        } else if (isSchemaLike(value)) {
          e[key] = widenStruct(value, mode)
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
        (current, [name, implementation]) =>
          current.handle(name, withDeclaredPermission(cube, name, withCustomFold(cube, name, implementation))),
        handlers,
      ),
    )
  })
  const [first, ...rest] = layers

  return (first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest)) as any
}

/**
 * The declaration IS the enforcement (QWB-54, 14c): whatever `routes` declares for this
 * endpoint is required here, before the handler runs, so a handler that forgets
 * `requirePermission` is still a 403. `null` (explicit or undeclared non-list) leaves the
 * handler to decide per request. Outermost wrapper on purpose: the permission answer comes
 * before the entity gate and before the custom fold touch the request.
 */
// Exported for runtime-composition.test.ts (QWB-54, 14c): the wrapper's behavior is the contract.
export const withDeclaredPermission = (cube: MountedCube, name: string, implementation: unknown) => {
  const permission = declaredPermission(cube.manifest.routes, cube.name, name)
  if (permission === null) return implementation
  const handler = implementation as Handler
  return (request: unknown) => Effect.flatMap(requirePermission(permission), () => handler(request))
}

/**
 * Wrap one handler so undeclared payload keys reach it folded under `custom` -- but only for
 * schemas THIS module widened, and only against the cube's active definitions, read at request
 * time. A cube with no defined custom fields keeps exactly its old behavior: undeclared keys
 * are stripped and nothing is stored, so a plain `<cube>:write` permission buys nothing until
 * an administrator defines a field (which is gated on `customfields:write`).
 *
 * The policy itself lives in custom-fold.ts (QWB-54 ticket 05): per-request definitions from
 * the provider's store (defect 4), create-vs-patch mode on the HTTP method (defect 1), and the
 * merged-cap CustomCapError answered as a 400 (defect 2). This side only decides WHICH handlers
 * are wrapped and with what.
 */
const withCustomFold = (cube: MountedCube, name: string, implementation: unknown) => {
  const endpoints = (
    cube.parts.group as {
      endpoints?: Record<string, { payloadSchema?: Option.Option<unknown>; method?: string }>
    }
  ).endpoints
  const payloadSchema = endpoints?.[name]?.payloadSchema
  // Item 7 of the QWB-46 review: a schema that is not a struct was never widened -- skip the
  // fold. Folding against an empty declared list would hand the handler an empty payload.
  if (!payloadSchema || !Option.isSome(payloadSchema) || !isStructSchema(payloadSchema.value)) {
    return implementation
  }
  const declared = declaredKeys(payloadSchema.value)
  // The method is the one honest signal that a payload CREATES a row: only POST demands the
  // required definitions outright. PATCH and PUT keep the present-and-empty semantics.
  const mode = endpoints?.[name]?.method === "POST" ? ("create" as const) : ("patch" as const)
  return withCustomFoldPolicy(cube.name, declared, mode, implementation)
}
