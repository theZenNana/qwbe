// Browser origins allowed to call the API cross-origin (QWB-42), read from
// QWBE_ALLOWED_ORIGINS as a comma-separated list (e.g.
// `http://localhost:3000,https://crm.example.com`).
//
// Default when the variable is unset: `["*"]` -- exactly the behaviour the server had before
// QWB-42, so local development (the sibling web app on its own port, the probes, curl) keeps
// working with zero configuration. Setting the variable to even one origin narrows the list
// immediately: an origin not in it gets no `access-control-allow-origin` header and the
// browser blocks the response.
//
// Malformed entries (empty items from stray commas, values without a scheme, embedded
// whitespace) throw with a clear message rather than being dropped silently -- a dropped
// entry would look like "one origin allowed" while actually being "none", and the mismatch
// would only surface as a browser CORS error far from its cause. The caller decides how the
// throw surfaces; the server routes it through its `fail` helper.

const ORIGIN_PATTERN = /^https?:\/\/[^/]+$/

export const allowedOrigins = (env: string | undefined): ReadonlyArray<string> => {
  if (env === undefined || env.trim() === "") return ["*"]
  const origins = env.split(",").map((o) => o.trim())
  for (const origin of origins) {
    if (origin === "")
      throw new Error(`QWBE_ALLOWED_ORIGINS: empty origin in "${env}" -- check for stray or doubled commas`)
    if (!ORIGIN_PATTERN.test(origin))
      throw new Error(
        `QWBE_ALLOWED_ORIGINS: "${origin}" is not a bare origin -- expected scheme://host[:port], no path, no trailing slash`,
      )
  }
  return origins
}
