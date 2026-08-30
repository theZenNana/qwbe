import type { CubeInfo } from "./api"
import type { PackageInfo } from "./contracts"

export const diskDrift = (cubes: Array<CubeInfo>, store: Array<PackageInfo>) => {
  const mounted = new Set(cubes.map((cube) => cube.name))
  // Installed packages cannot contain a cube already owned elsewhere: installation refuses
  // that collision. Therefore any declared cube absent from `mounted` is genuinely on disk but
  // waiting for restart, even when two uninstalled store packages declare the same name.
  const onDiskNotMounted = store.filter((pkg) => pkg.installed && pkg.cubes.some((cube) => !mounted.has(cube)))
  const mountedNotOnDisk = cubes.filter((cube) => !cube.onDisk).map((cube) => cube.name)
  return {
    mounted,
    onDiskNotMounted,
    mountedNotOnDisk,
    pendingRestart: onDiskNotMounted.length > 0 || mountedNotOnDisk.length > 0,
  }
}
