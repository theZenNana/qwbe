import path from "node:path"

// Next dev refuses to serve its own chunks to a page opened under any host it does not know
// (anything but localhost). The failure is silent in the browser: the page renders the initial
// "…" and never hydrates — no console error, no failed fetch to the API, just transient 503s
// on /_next/static chunks that only the dev server's own log explains. Opt hosts in with
// QWBE_DEV_ORIGINS, comma-separated: QWBE_DEV_ORIGINS=192.168.1.154 npm start
const devOrigins = (process.env.QWBE_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

/** @type {import('next').NextConfig} */
export default {
  distDir: process.env.QWBE_WEB_DIST_DIR ?? ".next",
  turbopack: { root: path.resolve(import.meta.dirname, "..") },
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),
}
