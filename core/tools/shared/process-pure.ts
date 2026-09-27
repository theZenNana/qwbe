const isAllowScripts = (key: string) => key.toLowerCase() === "npm_config_allow_scripts"

// `npm run` hands npm_config_allow_scripts to its children, and a child npm then fails with
// EALLOWSCRIPTS. The key stays, set to undefined: Node's spawn skips undefined values. Commands
// pass the result with extendEnv: false, because the executor would otherwise merge process.env
// back over this and the key would reach the child anyway.
export const withoutAllowScripts = (env: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, isAllowScripts(key) ? undefined : value]))

// The words before the first path-like operand: `npx --no-install secretlint a.ts b.ts ...` is named
// `npx --no-install secretlint`, so a finding never repeats a list of every tracked file.
export const commandName = (argv: ReadonlyArray<string>) => {
  const end = argv.findIndex((word, index) => index > 0 && /[./*]/.test(word) && !word.startsWith("-"))
  return (end === -1 ? argv : argv.slice(0, end)).join(" ")
}

export const lines = (text: string) => text.split("\n").filter(Boolean)
