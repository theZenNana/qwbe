const isAllowScripts = (key: string) => key.toLowerCase() === "npm_config_allow_scripts"

// `npm run` hands npm_config_allow_scripts to its children, and a child npm then fails with
// EALLOWSCRIPTS. The key stays, set to undefined: the executor merges this over process.env,
// and Node's spawn skips undefined values.
export const withoutAllowScripts = (env: Readonly<Record<string, string | undefined>>) =>
  Object.fromEntries(Object.entries(env).map(([key, value]) => [key, isAllowScripts(key) ? undefined : value]))

export const lines = (text: string) => text.split("\n").filter(Boolean)
