import type { CubeInfo, PackageInfo } from "./api"

export const diskDrift = (cubes: Array<CubeInfo>, store: Array<PackageInfo>) => {
  const mounted = new Set(cubes.map((cube) => cube.name))
  const onDiskNotMounted = store.filter((pkg) => pkg.installed && pkg.cubes.some((cube) => !mounted.has(cube)))
  const mountedNotOnDisk = cubes.filter((cube) => !cube.onDisk).map((cube) => cube.name)
  return {
    mounted,
    onDiskNotMounted,
    mountedNotOnDisk,
    pendingRestart: onDiskNotMounted.length > 0 || mountedNotOnDisk.length > 0,
  }
}
