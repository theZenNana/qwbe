// Shared custom-field shape, declared as a leaf module so catalogue.ts and
// custom-defs-reader.ts can both name it without importing each other (QWB-70).

/** One active custom-field definition, as the providing cube reports it. */
export type CustomFieldDefinition = {
  readonly name: string
  readonly label: string
  readonly fieldType: "text" | "number" | "date" | "bool" | "select"
  readonly required: boolean
  readonly options: ReadonlyArray<string>
  readonly position: number
}
