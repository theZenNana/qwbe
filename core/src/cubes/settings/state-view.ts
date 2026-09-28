import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"

type Installer = NonNullable<CubeTools["installer"]>
type CatalogueEntry = ReturnType<CubeTools["catalogue"]>[number]

export const cubeState = (installer: Installer, cube: CatalogueEntry | undefined) => {
  if (!cube) return Effect.succeed(undefined)
  return Effect.map(installer.cubeOnDisk(cube.name, cube.plugin), (onDisk) => ({
    name: cube.name,
    parent: cube.parent ?? null,
    enabled: cube.enabled,
    required: cube.required,
    system: cube.system,
    plugin: cube.plugin,
    prefix: cube.prefix ?? null,
    onDisk,
    entity: cube.entity ?? null,
    screen: cube.screen,
    agent: cube.agent,
    entityPermissions: cube.entityPermissions,
    publishes: cube.publishes,
    links: cube.links,
  }))
}
