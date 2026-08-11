import path from "node:path"

/** @type {import('next').NextConfig} */
export default {
  distDir: process.env.QWBE_WEB_DIST_DIR ?? ".next",
  turbopack: { root: path.resolve(import.meta.dirname, "..") },
}
