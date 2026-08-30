// The customfields half of the frontend's API surface, kept OUT of `api.ts` on purpose.
//
// `api.ts` is the app's own file. This one arrives with the customfields package and leaves with
// it: installing the package means copying two components and this module, and touching `api.ts`
// not at all. The same rule the backend lives by -- a thing you install does not edit a file that
// was already there -- applied to the frontend, where nothing enforces it for you.
//
// Every call here is OPTIONAL for the caller. If the cube is not installed or is switched off,
// these reject and the screens that use them render nothing.
//
// Ported on 2026-08-30 to the routes the current plugin declares: values are addressed by URL
// params and a body, not by path segments, because a values address belongs to ANOTHER cube's
// row and cannot be a path parameter of this one. Everything is a string on the wire -- numbers
// and booleans too -- since the type is the definition's business, not the transport's.

import { Schema } from "effect"
import { request } from "./api.ts"
import { PagedSchema } from "./contracts.ts"

export type FieldType = "text" | "number" | "date" | "bool" | "select"

export const FieldTypeSchema = Schema.Literal("text", "number", "date", "bool", "select")

export const CustomFieldDefSchema = Schema.Struct({
  id: Schema.String,
  targetCube: Schema.String,
  name: Schema.String,
  label: Schema.String,
  fieldType: FieldTypeSchema,
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
  position: Schema.Number,
})
export type CustomFieldDef = typeof CustomFieldDefSchema.Type

/** A definition plus what one row holds for it -- what a form needs, in one shape. */
export const FieldWithValueSchema = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  fieldType: FieldTypeSchema,
  options: Schema.Array(Schema.String),
  required: Schema.Boolean,
  position: Schema.Number,
  value: Schema.String,
})
export type FieldWithValue = typeof FieldWithValueSchema.Type

export const RowFieldsSchema = Schema.Struct({
  cube: Schema.String,
  rowId: Schema.String,
  fields: Schema.Array(FieldWithValueSchema),
})
export type RowFields = typeof RowFieldsSchema.Type

export const customFieldDefs = () => request("/customfields?limit=200", PagedSchema(CustomFieldDefSchema))

export const defineCustomField = (body: {
  targetCube: string
  name: string
  fieldType: FieldType
  label?: string
  options?: Array<string>
  required?: boolean
  position?: number
}) => request("/customfields", CustomFieldDefSchema, { method: "POST", body: JSON.stringify(body) })

export const removeCustomField = (id: string) =>
  request(`/customfields/${encodeURIComponent(id)}`, Schema.Struct({ removed: Schema.String }), { method: "DELETE" })

export const rowCustomFields = (cube: string, rowId: string) =>
  request(`/customfields/values?cube=${encodeURIComponent(cube)}&rowId=${encodeURIComponent(rowId)}`, RowFieldsSchema)

export const setRowCustomFields = (cube: string, rowId: string, values: Record<string, string>) =>
  request("/customfields/values", RowFieldsSchema, {
    method: "PUT",
    body: JSON.stringify({ cube, rowId, values }),
  })
