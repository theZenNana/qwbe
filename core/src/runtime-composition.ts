// The only audited type-erasure adapter.
// Runtime discovery makes the concrete union of HttpApi groups unknowable to TypeScript. Every
// cube is fully typed and runtime-validated before this seam; no erased value leaves it.

import { HttpApi, HttpApiBuilder, OpenApi } from "@effect/platform"
import { Layer } from "effect"
import type { MountedCube } from "./kernel/discovery.ts"

export const buildApi = (cubes: ReadonlyArray<MountedCube>): HttpApi.HttpApi<"cubes", never, never, never> => {
  const empty = HttpApi.make("cubes")
    .annotate(OpenApi.Title, "Qwbe -- kernel plus cubes discovered from disk")
    .annotate(
      OpenApi.Description,
      "One cube = one directory. Installing it touches no existing file. Plugins land in the same namespace.",
    )

  return cubes.reduce<any>((api, cube) => api.add(cube.parts.group), empty)
}

export const buildHandlers = (api: unknown, cubes: ReadonlyArray<MountedCube>): Layer.Layer<never, never, never> => {
  const layers = cubes.map((cube) => {
    const id = cube.parts.group.identifier
    return HttpApiBuilder.group(api as any, id as never, (handlers: any) =>
      Object.entries(cube.parts.handlers).reduce(
        (current, [name, implementation]) => current.handle(name, implementation),
        handlers,
      ),
    )
  })
  const [first, ...rest] = layers

  return (first === undefined ? Layer.empty : Layer.mergeAll(first, ...rest)) as any
}
