import { Effect, Option, Ref } from "effect"
import { mediateEntityCube } from "./entity-enforcement.ts"
import { DoubleCapabilityError } from "./kernel/errors-discovery.ts"
import type { CredentialVerifier, Manifest } from "./kernel/manifest.ts"
import { fullName } from "./kernel/manifest-validation.ts"
import { lateBound, noCredentials, noIdentityDirectory, noPermissionService } from "./late-bound-capabilities.ts"
import type { IdentityDirectory, PermissionService } from "./permissions-contracts.ts"

/**
 * The late-bound capabilities of one mount. Consumers get the wrappers at `create`; each
 * provider is bound when its own cube is created, whatever the directory order.
 */
export const capabilityRuntime = (manifests: ReadonlyArray<Manifest>) =>
  Effect.gen(function* () {
    const names = (flag: keyof Manifest) => manifests.filter((manifest) => manifest[flag] === true).map(fullName)
    for (const flag of [
      "providesCredentials",
      "usesCredentials",
      "providesIdentityDirectory",
      "providesEntityPermissions",
    ] as const) {
      const cubes = names(flag)
      if (cubes.length > 1) return yield* new DoubleCapabilityError(flag, cubes)
    }

    const verifier = yield* Ref.make(Option.none<CredentialVerifier>())
    const identity = yield* Ref.make(Option.none<IdentityDirectory>())
    const permission = yield* Ref.make(Option.none<PermissionService>())
    const permissions = lateBound(permission, noPermissionService)
    return {
      bind: {
        verifier: (provider: CredentialVerifier) => Ref.set(verifier, Option.some(provider)),
        identity: (provider: IdentityDirectory) => Ref.set(identity, Option.some(provider)),
        permission: (provider: PermissionService) => Ref.set(permission, Option.some(provider)),
      },
      credentials: lateBound(verifier, noCredentials),
      identities: lateBound(identity, noIdentityDirectory),
      permissions,
      mediate: <Parts extends Readonly<{ group: unknown; handlers: Readonly<Record<string, unknown>> }>>(
        cube: string,
        manifest: Readonly<{ entity?: string; providesIdentityDirectory?: boolean }>,
        parts: Parts,
      ) => mediateEntityCube(cube, manifest, parts, permissions),
    }
  })
