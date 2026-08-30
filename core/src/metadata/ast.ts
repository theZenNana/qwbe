// Walking an Effect Schema AST, without judging it.
//
// `metadata.ts` decides WHAT a field means for a frontend; this file answers the mechanical
// questions: which struct is the entity, which properties exist, what primitive a type
// resolves to, whether it is nullable, whether it is a literal union. Nothing here knows
// about cubes.

import { Schema } from "effect"
import type * as AST from "effect/SchemaAST"

export type Shape = { readonly type: string; readonly nullable: boolean; readonly enum: ReadonlyArray<string> | null }
export type TypeShape = Shape

const isTypeLiteral = (ast: AST.AST): ast is AST.TypeLiteral => ast._tag === "TypeLiteral"

export const classify = (ast: AST.AST): Shape => {
  switch (ast._tag) {
    case "StringKeyword":
      return { type: "string", nullable: false, enum: null }
    case "NumberKeyword":
      return { type: "number", nullable: false, enum: null }
    case "BooleanKeyword":
      return { type: "boolean", nullable: false, enum: null }
    case "Refinement":
      // Schema.Int refines NumberKeyword -> integer; a pattern refines a string -> string.
      return ast.from._tag === "NumberKeyword" ? { type: "integer", nullable: false, enum: null } : classify(ast.from)
    case "TupleType":
      return { type: "array", nullable: false, enum: null }
    case "Union": {
      // Null is a Literal in the AST (`literal: null`), not a keyword of its own.
      const isNull = (t: (typeof ast.types)[number]) =>
        t._tag === "Literal" && (t as { literal: unknown }).literal === null
      const literals = ast.types
        .filter((t) => t._tag === "Literal" && !isNull(t))
        .map((t) => String((t as { literal: unknown }).literal))
      const rest = ast.types.filter((t) => !isNull(t) && t._tag !== "Literal")
      const nullable = ast.types.some(isNull)
      const base: Shape = rest.length === 1 ? classify(rest[0]!) : { type: "unknown", nullable: false, enum: null }
      return {
        type: base.type,
        nullable: base.nullable || nullable,
        // A literal union (possibly with null) is an enum; anything wider is not.
        enum: literals.length > 0 && rest.every((t) => t._tag === "StringKeyword") ? literals : base.enum,
      }
    }
    default:
      return { type: "unknown", nullable: false, enum: null }
  }
}

export const groupEndpoints = (group: unknown): Record<string, { successSchema?: unknown; payloadSchema?: unknown }> =>
  (group as { endpoints?: Record<string, never> }).endpoints ?? {}

// A Schema is a class instance -- `typeof "function"`, not "object".
const isSchemaLike = (schema: unknown): schema is { readonly ast: AST.AST } =>
  !!schema && (typeof schema === "object" || typeof schema === "function") && "ast" in schema

export const typeLiteralOf = (schema: unknown): AST.TypeLiteral | undefined => {
  if (!isSchemaLike(schema)) return undefined
  // The guard proved only that an AST is reachable; `never` satisfies typeSchema's invariants
  // without widening what was checked.
  const ast = Schema.typeSchema(schema as never).ast
  return isTypeLiteral(ast) ? ast : undefined
}

/** The create payload's ENCODED side: presence there means the caller may set the field. */
export const encodedLiteralOf = (schema: unknown): AST.TypeLiteral | undefined => {
  if (!isSchemaLike(schema)) return undefined
  const ast = Schema.encodedSchema(schema as never).ast
  return isTypeLiteral(ast) ? ast : undefined
}

/**
 * The entity struct of a cube, from its REAL contract: the success schema of the `get`
 * endpoint, or the row schema inside the `list` endpoint's page. Nothing is declared twice.
 */
export const entityStructOf = (group: unknown): AST.TypeLiteral | undefined => {
  const endpoints = groupEndpoints(group)
  const get = typeLiteralOf(endpoints.get?.successSchema)
  if (get) return get
  const page = typeLiteralOf(endpoints.list?.successSchema)
  if (!page) return undefined
  const rows = page.propertySignatures.map((p) => p.type).find((t) => t._tag === "TupleType")
  const element = (rows as { element?: AST.AST } | undefined)?.element
  return element && isTypeLiteral(element) ? element : undefined
}
