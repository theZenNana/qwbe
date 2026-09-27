// The discovery-time errors, shared by scan.ts (the walk) and discovery.ts (the mount).

import { Data } from "effect"

export class BrokenCubeError extends Data.TaggedError("BrokenCubeError")<{ readonly message: string }> {
  constructor(name: string, cause: string) {
    super({
      message:
        `Cube "${name}" failed to load: ${cause}\n` +
        `A broken cube stops startup rather than being skipped silently -- otherwise the system ` +
        `would come up with half its cubes and nobody would notice.\n` +
        `Remove its directory if you want to start without it.`,
    })
  }
}

export class DuplicateCubeError extends Data.TaggedError("DuplicateCubeError")<{ readonly message: string }> {
  constructor(name: string, sources: ReadonlyArray<string>) {
    super({
      message:
        `Two cubes are called "${name}": ${sources.join(" and ")}. ` +
        `Level 0 is one flat namespace, so names must be unique across core and every plugin. ` +
        `Rename one, or uninstall the plugin.`,
    })
  }
}

export class DoubleCapabilityError extends Data.TaggedError("DoubleCapabilityError")<{ readonly message: string }> {
  constructor(capability: string, cubes: ReadonlyArray<string>) {
    super({
      message:
        `More than one cube declares \`${capability}\`: ${cubes.join(", ")}. ` +
        `A declared capability has exactly one holder -- two would make it ambiguous which one ` +
        `the kernel wires up, and ambiguity in a security path is a defect by itself.`,
    })
  }
}

export class DoublePrivilegeError extends Data.TaggedError("DoublePrivilegeError")<{ readonly message: string }> {
  constructor(cubes: ReadonlyArray<string>) {
    super({
      message:
        `More than one cube asks for \`managesCubes: true\`: ${cubes.join(", ")}. ` +
        `At most one may hold the switches -- two could disable each other and leave the system ` +
        `with no way to turn anything back on.`,
    })
  }
}
