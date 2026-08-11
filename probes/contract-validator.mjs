// Small OpenAPI 3.1 response validator used by the contract probe. It deliberately supports
// only the JSON Schema vocabulary emitted by Effect for this repository. Unknown keywords are
// harmless annotations; an unknown shape fails closed instead of pretending it was checked.

const unescapePointer = (part) => part.replaceAll("~1", "/").replaceAll("~0", "~")

const resolve = (root, schema) => {
  if (!schema?.$ref) return schema
  if (!schema.$ref.startsWith("#/")) return undefined
  return schema.$ref
    .slice(2)
    .split("/")
    .map(unescapePointer)
    .reduce((value, key) => value?.[key], root)
}

export const schemaIsDeclared = (root, initial, seen = new Set()) => {
  if (!initial || typeof initial !== "object" || Array.isArray(initial)) return false
  const schema = resolve(root, initial)
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
  if (seen.has(schema)) return true
  const nextSeen = new Set(seen).add(schema)
  const nested = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items ? [schema.items] : []),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ]
  return nested.every((item) => schemaIsDeclared(root, item, nextSeen))
}

export const operationSignature = (path, method, operation) => {
  const parameters = (operation.parameters ?? [])
    .map((parameter) => `${parameter.in}:${parameter.name}${parameter.required ? "!" : ""}`)
    .sort()
    .join(",")
  const body = operation.requestBody ? "body" : "-"
  const responses = Object.keys(operation.responses ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .join(",")
  return `${method.toUpperCase()} ${path}|${parameters || "-"}|${body}|${responses}`
}

export const operationContractIsDeclared = (root, path, operation) => {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return false
  const parameters = operation.parameters ?? []
  if (!Array.isArray(parameters)) return false
  const identities = parameters.map((parameter) => `${parameter?.in}:${parameter?.name}`)
  if (new Set(identities).size !== identities.length) return false
  if (
    parameters.some(
      (parameter) =>
        !parameter ||
        typeof parameter.name !== "string" ||
        !["path", "query", "header", "cookie"].includes(parameter.in) ||
        (parameter.in === "path" && parameter.required !== true) ||
        !schemaIsDeclared(root, parameter.schema),
    )
  )
    return false

  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()
  const pathParameters = parameters
    .filter((parameter) => parameter.in === "path")
    .map((parameter) => parameter.name)
    .sort()
  if (placeholders.join("\0") !== pathParameters.join("\0")) return false

  if (operation.requestBody) {
    const bodySchema = operation.requestBody.content?.["application/json"]?.schema
    if (!schemaIsDeclared(root, bodySchema)) return false
  }

  const responses = operation.responses
  if (!responses || typeof responses !== "object" || Object.keys(responses).length === 0) return false
  return Object.values(responses).every((response) =>
    schemaIsDeclared(root, response?.content?.["application/json"]?.schema),
  )
}

export const validates = (root, initial, value, seen = new Set()) => {
  const schema = resolve(root, initial)
  if (!schema || typeof schema !== "object") return false
  if (seen.has(schema)) return true
  const nextSeen = new Set(seen).add(schema)

  if (schema.const !== undefined && value !== schema.const) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (schema.anyOf && !schema.anyOf.some((item) => validates(root, item, value, nextSeen))) return false
  if (schema.oneOf && schema.oneOf.filter((item) => validates(root, item, value, nextSeen)).length !== 1) return false
  if (schema.allOf && !schema.allOf.every((item) => validates(root, item, value, nextSeen))) return false

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length > 0) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    const matches = types.some(
      (type) => type === actual || (type === "integer" && actual === "number" && Number.isInteger(value)),
    )
    if (!matches) return false
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.items && !value.every((item) => validates(root, schema.items, item, nextSeen))) return false
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ((schema.required ?? []).some((key) => !Object.hasOwn(value, key))) return false
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key]
      if (property && !validates(root, property, item, nextSeen)) return false
      if (!property && schema.additionalProperties === false) return false
      if (!property && typeof schema.additionalProperties === "object") {
        if (!validates(root, schema.additionalProperties, item, nextSeen)) return false
      }
    }
  }

  return true
}

export const responseSchema = (spec, path, method, status) =>
  spec.paths?.[path]?.[method]?.responses?.[String(status)]?.content?.["application/json"]?.schema

export const responseConforms = (spec, path, method, status, body) => {
  const operation = spec.paths?.[path]?.[method]
  const response = operation?.responses?.[String(status)]
  if (!operation || !response) return false
  const schema = response.content?.["application/json"]?.schema
  return schema ? validates(spec, schema, body) : body === "" || body === undefined
}
