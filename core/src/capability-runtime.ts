import { Effect } from "effect"
import { DoubleCapabilityError } from "./kernel/errors-discovery.ts"
import type { CredentialVerifier, Manifest } from "./kernel/manifest.ts"
import { fullName } from "./kernel/manifest-validation.ts"
import { lateBoundIdentityDirectory, lateBoundPermissionService } from "./late-bound-capabilities.ts"
import type { IdentityDirectory, PermissionService } from "./permissions-contracts.ts"

export const capabilityRuntime = (manifests: ReadonlyArray<Manifest>) => {
  const names = (flag: keyof Manifest) => manifests.filter((manifest) => manifest[flag] === true).map(fullName)
  for (const flag of [
    "providesCredentials",
    "usesCredentials",
    "providesIdentityDirectory",
    "providesEntityPermissions",
  ] as const) {
    const cubes = names(flag)
    if (cubes.length > 1) throw new DoubleCapabilityError(flag, cubes)
  }

  const verifierHolder: { current?: CredentialVerifier } = {}
  const identityHolder: { current?: IdentityDirectory } = {}
  const permissionHolder: { current?: PermissionService } = {}
  const credentials: CredentialVerifier = {
    verify: (username, password) =>
      verifierHolder.current ? verifierHolder.current.verify(username, password) : Effect.succeed(undefined),
  }
  return {
    holders: { verifier: verifierHolder, identity: identityHolder, permission: permissionHolder },
    credentials,
    identities: lateBoundIdentityDirectory(identityHolder),
    permissions: lateBoundPermissionService(permissionHolder),
  }
}
