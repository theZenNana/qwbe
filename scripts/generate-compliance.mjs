import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const locks = ["package-lock.json", "core/package-lock.json", "web/package-lock.json"]
const packages = new Map()

for (const lockName of locks) {
  const lock = JSON.parse(readFileSync(resolve(root, lockName), "utf8"))
  for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
    if (!path?.includes("node_modules/") || !pkg.version) continue
    const name = path.slice(path.lastIndexOf("node_modules/") + 13)
    const key = `${name}@${pkg.version}`
    packages.set(key, { name, version: pkg.version, license: pkg.license ?? "NOASSERTION" })
  }
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
const notices = [
  "# Third-party notices",
  "",
  "Generated from the three committed npm lockfiles by `npm run compliance`.",
  "Package source and license text are available from the npm package identified below.",
  "",
  "| Package | Version | SPDX license |",
  "|---|---:|---|",
  ...sorted.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  "",
].join("\n")

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "qwbe-npm-dependencies",
  documentNamespace: "https://qwbe.invalid/spdx/qwbe-lockfiles",
  creationInfo: { created: "2026-08-09T00:00:00Z", creators: ["Tool: scripts/generate-compliance.mjs"] },
  packages: sorted.map((p, i) => ({
    SPDXID: `SPDXRef-Package-${i + 1}`,
    name: p.name,
    versionInfo: p.version,
    downloadLocation: "NOASSERTION",
    licenseConcluded: p.license,
    licenseDeclared: p.license,
    filesAnalyzed: false,
  })),
}

writeFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), notices)
const sbomText = JSON.stringify(sbom, null, 2).replace(
  '"creators": [\n      "Tool: scripts/generate-compliance.mjs"\n    ]',
  '"creators": ["Tool: scripts/generate-compliance.mjs"]',
)
writeFileSync(resolve(root, "sbom.spdx.json"), `${sbomText}\n`)
console.log(`Compliance files generated for ${sorted.length} package versions.`)
