import { Effect } from "effect"
import type { CubeTools } from "qwbe-core/cube"

type Installer = NonNullable<CubeTools["installer"]>

export const cubeState = (catalogue: CubeTools["catalogue"], installer: Installer, name: string) => {
  const cube = catalogue().find((candidate) => candidate.name === name)
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
