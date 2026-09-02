// The discovery-time errors, shared by scan.ts (the walk) and discovery.ts (the mount).

export class BrokenCubeError extends Error {
  constructor(name: string, cause: string) {
    super(
      `Cube "${name}" failed to load: ${cause}\n` +
        `A broken cube stops startup rather than being skipped silently -- otherwise the system ` +
        `would come up with half its cubes and nobody would notice.\n` +
        `Remove its directory if you want to start without it.`,
    )
    this.name = "BrokenCubeError"
  }
}

export class DuplicateCubeError extends Error {
  constructor(name: string, sources: ReadonlyArray<string>) {
    super(
      `Two cubes are called "${name}": ${sources.join(" and ")}. ` +
        `Level 0 is one flat namespace, so names must be unique across core and every plugin. ` +
        `Rename one, or uninstall the plugin.`,
    )
    this.name = "DuplicateCubeError"
  }
}

export class DoubleCapabilityError extends Error {
  constructor(capability: string, cubes: ReadonlyArray<string>) {
    super(
      `More than one cube declares \`${capability}\`: ${cubes.join(", ")}. ` +
        `A declared capability has exactly one holder -- two would make it ambiguous which one ` +
        `the kernel wires up, and ambiguity in a security path is a defect by itself.`,
    )
    this.name = "DoubleCapabilityError"
  }
}

export class DoublePrivilegeError extends Error {
  constructor(cubes: ReadonlyArray<string>) {
    super(
      `More than one cube asks for \`managesCubes: true\`: ${cubes.join(", ")}. ` +
        `At most one may hold the switches -- two could disable each other and leave the system ` +
        `with no way to turn anything back on.`,
    )
    this.name = "DoublePrivilegeError"
  }
}
