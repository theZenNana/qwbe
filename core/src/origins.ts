// Browser origins allowed to call the API cross-origin (QWB-42), read from
// QWBE_ALLOWED_ORIGINS as a comma-separated list (e.g.
// `http://localhost:3000,https://crm.example.com`).
//
// Default when the variable is undefined: `["*"]` -- exactly the behaviour the server had
// before QWB-42, so local development (the sibling web app on its own port, the probes, curl)
// keeps working with zero configuration. A variable that is SET but empty or whitespace-only
// is a malformed value and throws, like any other malformed entry -- `VAR=$MISSING` shipping
// an accidentally empty value must not silently widen the server back to `*`.
//
// With the variable set, the list is exact: an origin not in it gets no
// `access-control-allow-origin` header and the browser blocks the response. Entries are
// canonicalized through `new URL(entry).origin`, so `https://a.test:443` and `HTTPS://a.test`
// match the default-port-stripped, lowercased form browsers actually send.
//
// Malformed entries (empty items from stray commas, values without a scheme, hosts with
// characters outside hostname/port syntax, wildcard hosts like `https://*.example.com`)
// throw with a clear message rather than being dropped silently -- a dropped entry would look
// like "one origin allowed" while actually being "none", and the mismatch would only surface
// as a browser CORS error far from its cause. Wildcard subdomains are unsupported because the
// CORS layer matches exactly; an entry like `https://*.example.com` could never match and
// would be stamped verbatim onto every response. The caller decides how the throw surfaces;
// the server routes it through its `fail` helper.

const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/i

export const allowedOrigins = (env: string | undefined): ReadonlyArray<string> => {
  // Only an UNSET variable defaults to `["*"]`. A set-but-empty or whitespace-only value is
  // malformed and throws -- see the module comment.
  if (env === undefined) return ["*"]
  const origins = env.split(",").map((o) => o.trim())
  const canonical: string[] = []
  for (const [index, origin] of origins.entries()) {
    if (origin === "")
      throw new Error(
        `QWBE_ALLOWED_ORIGINS: empty origin at position ${index + 1} -- check for stray or doubled commas`,
      )
    if (origin.includes("*"))
      throw new Error(
        `QWBE_ALLOWED_ORIGINS: "${origin}" uses a wildcard -- wildcard subdomains are unsupported, list origins exactly`,
      )
    if (!ORIGIN_PATTERN.test(origin))
      throw new Error(
        `QWBE_ALLOWED_ORIGINS: "${origin}" is not a bare origin -- expected scheme://host[:port], no path, no trailing slash`,
      )
    canonical.push(new URL(origin).origin)
  }
  return canonical
}
