// The customfields half of the frontend's API surface, kept OUT of `api.ts` on purpose.
//
// `api.ts` is the app's own file. This one arrives with the customfields package and leaves with
// it: installing the package means copying two components and this module, and touching `api.ts`
// not at all. The same rule the backend lives by -- a thing you install does not edit a file that
// was already there -- applied to the frontend, where nothing enforces it for you.
//
// Every call here is OPTIONAL for the caller. If the cube is not installed or is switched off,
// these reject and the screens that use them render nothing.

import { type Paged, request } from "./api"

export type FieldType = "text" | "number" | "date" | "bool" | "select"

export type CustomFieldDef = {
  id: string
  targetCube: string
  name: string
  label: string
  fieldType: FieldType
  options: Array<string>
  required: boolean
  position: number
}

/** A definition plus what one row holds for it -- what a form needs, in one shape. */
export type FieldWithValue = {
  name: string
  label: string
  fieldType: FieldType
  options: Array<string>
  required: boolean
  position: number
  value: string
}

export type RowFields = { cube: string; rowId: string; fields: Array<FieldWithValue> }

export const customFieldDefs = (cube?: string) =>
  request<Paged<CustomFieldDef>>(`/customfields?limit=200${cube ? `&cube=${encodeURIComponent(cube)}` : ""}`)

export const defineCustomField = (body: {
  targetCube: string
  name: string
  fieldType: FieldType
  label?: string
  options?: Array<string>
  required?: boolean
  position?: number
}) => request<CustomFieldDef>("/customfields", { method: "POST", body: JSON.stringify(body) })

export const removeCustomField = (id: string) =>
  request<{ removed: string }>(`/customfields/${id}`, { method: "DELETE" })

export const rowCustomFields = (cube: string, id: string) => request<RowFields>(`/customfields/values/${cube}/${id}`)

export const setRowCustomFields = (cube: string, id: string, values: Record<string, string>) =>
  request<RowFields>(`/customfields/values/${cube}/${id}`, { method: "PUT", body: JSON.stringify({ values }) })
