// The settings cube's route permissions, declared ONCE (QWB-54, ticket 10).
//
// The manifest publishes this object through the kernel's metadata, and the handlers in
// index.ts and packages.ts check through the same names -- so renaming a permission means
// editing here and the `permissions` list, and nothing else in the system holds the old
// name. The mount gate (`validateRoutes`) refuses a name here that is not an endpoint of
// the cube or a permission the cube does not declare.
export const ROUTES = {
  cubes: "settings:read",
  toggle: "settings:write",
  packages: "settings:write",
  install: "settings:write",
  installFrom: "settings:write",
  uninstall: "settings:write",
  uninstallPackage: "settings:write",
  scanPackages: "settings:write",
  forgetShelf: "settings:write",
  restart: "settings:write",
} as const
