// 22.18 is the first Node that runs .ts files without a flag; tests and the API rely on it.
const REQUIRED = [22, 18, 0] as const

// Each directory has its own package-lock.json; `npm ci` runs in this order.
export const INSTALL_DIRS = [".", "core", "web"] as const

export const INSTALL_ARGV = ["npm", "ci", "--no-audit", "--no-fund"] as const

// True when `version` ("v22.18.0" or "22.18") is REQUIRED or newer; missing parts count as 0.
export const meetsRequired = (version: string) => {
  const have = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  const difference = REQUIRED.map((part, index) => (have[index] ?? 0) - part).find((d) => d !== 0) ?? 0
  return difference >= 0
}

export const nodeOkMessage = (version: string) => `node ${version}: ok (need >= ${REQUIRED.join(".")})`

export const tooOldMessage = (have: string) =>
  `Qwbe needs Node ${REQUIRED.join(".")} or newer; you have ${have}. ` +
  "The API and tests run TypeScript through Node type stripping. " +
  "Install a newer Node (for example `nvm install 22`), then run `npm run setup` again."

export const installFailedMessage = (dir: string, status: number) =>
  `npm ci failed in ${dir} (exit ${status}); nothing after it ran`

export const dataDirFor = (root: string, fromEnv: string | undefined) => fromEnv ?? `${root}data`
