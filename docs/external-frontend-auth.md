# Authenticating an external frontend against qwbe

For a Next.js application served from a different port or host than qwbe.
Companion to `docs/api.md` (what the endpoints look like) and QWB-42 (where the
set of allowed origins comes from). Every claim about the server side is
enforced by code in this repository; the cookie parts are the frontend's
responsibility and are marked as such.

## The one rule

**The browser never sees the Bearer token.** The token qwbe's `POST /auth/login`
returns is a full session credential -- anyone holding it is that user until it
expires. If it lands in a browser it can be read from JavaScript, devtools, or a
XSS payload. So the token lives only in the Next.js server process, inside an
httpOnly cookie, and every call to qwbe goes through a Next.js route handler
that acts as a proxy: browser -> Next route handler -> qwbe.

## What qwbe enforces

- **Origin allowlist (CORS).** Browser requests carrying an `Origin` header get
  `access-control-allow-origin` only if the origin is in `QWBE_ALLOWED_ORIGINS`
  (comma-separated, e.g. `http://localhost:3000,https://crm.example.com`).
  Unset, the list is `["*"]` -- the pre-QWB-42 behaviour, fine for local
  development, never for an exposed deployment. Malformed entries stop the
  server at startup with a clear message. CORS is a *browser* enforcement: it
  protects your users from other pages, not the API from non-browser clients.
  Authentication does that part.
- **Authentication.** Every route except `POST /auth/login` requires
  `Authorization: Bearer <token>`. Tokens are opaque random 32-byte values,
  stored server-side only as a sha256 hash, expiring after 7 days
  (`SESSION_TTL_MS` in `core/src/cubes/auth/index.ts`; the login response
  carries the exact `expiresAt`). A leaked database yields no usable sessions.
- **Authorization.** Roles and per-cube permissions (`notes:read`, ...) are
  checked server-side on every request. The proxy can hide the API; it cannot
  grant rights.

## What the frontend is responsible for

Everything between the browser and qwbe:

1. **Login.** A route handler (`app/api/login/route.ts`) receives the
   credentials from the browser, calls qwbe's `POST /auth/login` server-side,
   and sets a cookie with the token. The token itself is never in the response
   body.

2. **Cookie attributes** -- all of them, set by Next:

   | Attribute      | Value | Why |
   |----------------|-------|-----|
   | `httpOnly`     | `true` | JavaScript must not read the token. This is the point of the whole design. |
   | `secure`       | `true` (in production; HTTPS) | The token must not travel over plain HTTP. |
   | `sameSite`     | `"lax"` | Blocks cross-site sends from third-party pages while keeping normal navigation working. Use `"strict"` if the app tolerates it. |
   | `path`         | `/api` (or the proxy prefix) | The cookie rides only on calls to your proxy, not on every request. |
   | `expires`      | qwbe's `expiresAt` from the login response | Cookie and token expire together; a longer cookie holds a dead token, a shorter one logs people out early. |

3. **Proxying.** Route handlers under e.g. `app/api/qwbe/[...path]/route.ts`
   read the cookie, forward the request to qwbe with
   `Authorization: Bearer <token>`, and relay the response. Add no
   `Authorization` header from the browser; add none from the client-side
   fetches either.

4. **On 401.** On the cube routes qwbe answers
   `{"message":"invalid or expired token","_tag":"Unauthorized"}`. (Exception: the
   authenticated `/openapi.json` route answers 401 with an EMPTY body -- a proxy must not
   rely on parsing the body there.) The proxy
   passes the 401 through; the client sees it and redirects to the login
   screen. Distinguish "wrong credentials" (login returned 401 -- show the
   error) from "session ended" (a proxied call returned 401 -- clear the cookie
   and re-authenticate).

5. **Logout.** A route handler calls qwbe's `POST /auth/logout` (which deletes
   all of that user's sessions server-side) and clears the cookie. Do both
   every time: clearing only the cookie leaves live sessions behind, calling
   only qwbe leaves a cookie that will just 401 on the next request. Note that
   `/auth/logout` itself is behind `Authorization`, so with an already-expired
   token it answers 401 -- that is expected and non-fatal. Treat it as "session
   already gone" and clear the cookie regardless.

6. **Re-login.** When the token expires, the next proxied call 401s, the client
   clears the cookie and shows the login form again. There is no refresh token
   and no silent renewal in this prototype: the session length is 7 days and
   then the user logs in again.

## Why a proxy and not direct calls with CORS alone

CORS stops *other* pages from making the browser call your API. It does nothing
about scripts running *in your own page*, which is why the token must not be in
the page's reach. `httpOnly` + proxy is the combination that keeps it out;
`QWBE_ALLOWED_ORIGINS` is the belt for any request that still travels
browser-to-qwbe -- in the proxy layout there should be none, which is exactly
right.

## Quick check that the origin list works

With the server started as
`QWBE_ALLOWED_ORIGINS=http://localhost:3000 node core/src/main.ts`:

- a request whose `Origin` is `http://localhost:3000` gets
  `access-control-allow-origin: http://localhost:3000`;
- the same request with `Origin: http://evil.example` gets no CORS header at
  all, and the browser (only the browser) blocks reading the response. This
  holds for a list of any length, including exactly one origin -- the server
  checks every request's Origin against the list, it never stamps a constant
  header.

Also note the defaults: with `QWBE_ALLOWED_ORIGINS` unset the server starts
with CORS wide open (`access-control-allow-origin: *`) and prints a warning
saying so; with `NODE_ENV=production` it refuses to start instead. A variable
that is set but empty is a malformed value and also refuses to start -- it
does NOT fall back to `*`.
