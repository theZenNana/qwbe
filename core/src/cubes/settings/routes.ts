// Route permissions, published by the metadata and checked by the handlers (see metadata/declarations.ts).
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
