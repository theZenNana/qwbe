// Migration ownership -- who may move whose data, checked before a byte moves.
//
// Split out of migrate.ts on 2026-08-11 (file cap -- "split the file, don't raise the
// number"). The checks here are the wall between a package's CLAIM and the kernel's RECORD.
//
// Since QWB-44 the data lives in one Postgres schema per cube, so "does the legacy file
// exist" became "does the legacy schema exist" -- answered by Postgres, not the filesystem,
// which is why the check is async and the caller (main.ts) awaits it before mount.

import type { Ledger } from "./ledger.ts"
import type { DataMigration, Manifest } from "./manifest.ts"
import { getPool } from "./pg/db.ts"
import { schemaName } from "./pg/setup.ts"

export class MigrationOwnershipError extends Error {
  constructor(reason: string) {
    super(`Data migration refused by the ownership rules: ${reason}`)
    this.name = "MigrationOwnershipError"
  }
}

const schemaExists = async (cube: string): Promise<boolean> => {
  const r = await getPool().query(`SELECT 1 FROM information_schema.schemata WHERE schema_name = $1`, [
    schemaName(cube),
  ])
  return (r.rowCount ?? 0) > 0
}

/**
 * Validate every declared migration against the mounted set AND the ledger snapshot.
 *
 *   - `toCube` must be a mounted cube of the SAME package as the declarer;
 *   - `fromCube` must NOT be a currently-mounted cube of another package -- a live cube's
 *     schema is not legacy data;
 *   - `fromPlugin` is REQUIRED, and must match the ledger's record for `fromCube`;
 *   - a source with NO ledger record is refused by default. The one exception is pre-ledger
 *     history, and the manifest does not get to claim it: an administrator authorizes the
 *     legacy claim with QWBE_LEGACY_MIGRATIONS="bookmarks:example-plugin,tags:example-plugin"
 *     -- a decision from the operator's side, not from the package being checked.
 */
export const checkMigrationOwnership = async (
  definitions: ReadonlyArray<{ name: string; plugin: string | null; definition: { manifest: Manifest } }>,
  ledger: Ledger,
): Promise<Array<DataMigration>> => {
  const mounted = new Map(definitions.map((d) => [d.name, d.plugin]))
  const legacyAuthorized = new Map(
    (process.env.QWBE_LEGACY_MIGRATIONS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [cube, plugin] = s.split(":")
        return [cube, plugin === "core" ? null : plugin] as const
      }),
  )
  const pkg = (p: string | null) => (p === null ? "core" : `plugin "${p}"`)
  const migrations: Array<DataMigration> = []
  for (const { name, plugin, definition } of definitions) {
    for (const m of definition.manifest.dataMigration ?? []) {
      const toPlugin = mounted.get(m.toCube)
      if (toPlugin === undefined) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.toCube}" is not mounted. ` +
            `A migration runs only when its destination is.`,
        )
      }
      if (toPlugin !== plugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.toCube}" belongs to ` +
            `${pkg(toPlugin)} -- not to the declaring package.`,
        )
      }
      const fromMounted = mounted.get(m.fromCube)
      if (fromMounted !== undefined && fromMounted !== plugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube}, but "${m.fromCube}" is a mounted cube of ` +
            `${pkg(fromMounted)} -- its schema is live, not legacy. A package can only migrate its OWN history.`,
        )
      }
      // No source schema, nothing to migrate: the declaration is inert this boot. The package
      // checks above still ran (a half-mounted package is a defect regardless); the
      // provenance checks below only matter when there is a schema to move.
      if (!(await schemaExists(m.fromCube))) {
        migrations.push(m)
        continue
      }
      // Runtime-required too: the TYPE says fromPlugin is mandatory, but a cube's index.ts
      // is imported code -- a plain JS cube can omit it and the type never runs.
      if (m.fromPlugin === undefined) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} -> ${m.toCube} without naming the source package. ` +
            `\`fromPlugin\` is required: the claim is checked against the kernel's ledger -- not trusted.`,
        )
      }
      const recorded = ledger[m.fromCube]
      if (recorded !== undefined) {
        if (recorded !== m.fromPlugin) {
          throw new MigrationOwnershipError(
            `"${name}" declares ${m.fromCube} came from ${pkg(m.fromPlugin)}, but the ledger records ` +
              `${pkg(recorded)}. The ledger is kernel-written at mount -- the manifest cannot rewrite it.`,
          )
        }
      } else {
        // No ledger record: either a pre-ledger schema (needs the operator's explicit say-so)
        // or a schema whose history is simply unknown -- and unknown is refused.
        const authorized = legacyAuthorized.get(m.fromCube)
        if (authorized === undefined || authorized !== m.fromPlugin) {
          throw new MigrationOwnershipError(
            `"${name}" declares ${m.fromCube} -> ${m.toCube}, but the ledger has no record of ` +
              `"${m.fromCube}". Pre-ledger history is migrated only with the operator's explicit ` +
              `authorization: QWBE_LEGACY_MIGRATIONS="${m.fromCube}:${m.fromPlugin ?? "core"}".`,
          )
        }
      }
      if (m.fromPlugin !== toPlugin) {
        throw new MigrationOwnershipError(
          `"${name}" declares ${m.fromCube} came from ${pkg(m.fromPlugin)}, but the destination ` +
            `"${m.toCube}" belongs to ${pkg(toPlugin)}. The claimed provenance is not this package's.`,
        )
      }
      migrations.push(m)
    }
  }
  return migrations
}
