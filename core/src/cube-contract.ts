import { HttpApiGroup } from "@effect/platform"
import type { CubeGroup, CubeParts, CubeTools, Manifest } from "./kernel/manifest.ts"

export type { CubeTools } from "./kernel/manifest.ts"

export type CubeDefinition<Group extends CubeGroup = CubeGroup> = {
  readonly manifest: Manifest
  readonly create: (tools: CubeTools) => CubeParts<Group>
}

/** Preserve the group/handler relationship until runtime discovery erases the concrete group. */
export const defineCube = <const Group extends CubeGroup>(
  group: Group,
  definition: Omit<CubeDefinition<Group>, "create"> & {
    readonly create: (tools: CubeTools) => Omit<CubeParts<Group>, "group"> & { readonly group?: never }
  },
): CubeDefinition<Group> => ({
  manifest: definition.manifest,
  create: (tools) => ({ group, ...definition.create(tools) }),
})

export class InvalidCubeContractError extends Error {
  constructor(cube: string, reason: string) {
    super(`Invalid cube contract "${cube}": ${reason}`)
    this.name = "InvalidCubeContractError"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const isCubeDefinition = (value: unknown): value is CubeDefinition =>
  isRecord(value) && isRecord(value.manifest) && typeof value.create === "function"

export const decodeCubeExport = (moduleValue: unknown, cube: string): CubeDefinition => {
  if (!isRecord(moduleValue) || !isRecord(moduleValue.cube)) {
    throw new InvalidCubeContractError(cube, "index.ts does not export `cube`")
  }
  const definition = moduleValue.cube
  if (!isCubeDefinition(definition)) {
    const reason = !isRecord(definition.manifest) ? "definition has no `manifest`" : "definition has no `create`"
    throw new InvalidCubeContractError(cube, reason)
  }
  return definition
}

export const validateCubeParts = (cube: string, parts: unknown): void => {
  if (!isRecord(parts)) throw new InvalidCubeContractError(cube, "create did not return an object")
  if (!HttpApiGroup.isHttpApiGroup(parts.group) || !("endpoints" in parts.group) || !isRecord(parts.group.endpoints)) {
    throw new InvalidCubeContractError(cube, "group is not an HttpApiGroup")
  }
  const handlerRecord = parts.handlers
  if (!isRecord(handlerRecord)) throw new InvalidCubeContractError(cube, "handlers is not an object")

  const endpoints = Object.keys(parts.group.endpoints).sort()
  const handlers = Object.keys(handlerRecord).sort()
  const missing = endpoints.filter((name) => !handlers.includes(name))
  const extra = handlers.filter((name) => !endpoints.includes(name))
  const invalid = handlers.filter((name) => typeof handlerRecord[name] !== "function")
  if (missing.length + extra.length + invalid.length > 0) {
    const reasons = [
      missing.length > 0 ? `missing handlers: ${missing.join(", ")}` : "",
      extra.length > 0 ? `extra handlers: ${extra.join(", ")}` : "",
      invalid.length > 0 ? `non-function handlers: ${invalid.join(", ")}` : "",
    ].filter(Boolean)
    throw new InvalidCubeContractError(cube, reasons.join("; "))
  }
}
