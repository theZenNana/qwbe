#!/usr/bin/env node
// The `qwbe` binary, delivered by qwbe-core. A pack installs the kernel
// from the tarball `npm pack` produces, and `node_modules/.bin/qwbe` is how its npm scripts
// reach the command: `scripts.test` is `qwbe check .`, and that must be the WHOLE test story --
// the pack does not get to choose its own gates.
//
// This file is only the entry; the command lives in core/src/qwbe-cli.ts and every rule in
// core/src/check-package.ts, where it is unit-tested. It stays .mjs: node does not run
// TypeScript from node_modules.
//
// Where the command loads from: node refuses to strip types for any file under node_modules, so
// an installed kernel (bin/qwbe.mjs inside node_modules/qwbe-core) imports the compiled
// dist/qwbe-cli.js that prepack built into the tarball. A checkout runs the very TypeScript
// source the kernel boots -- one checker, no second implementation to drift.
const installed = import.meta.url.includes("/node_modules/")
const { main } = await import(installed ? "../dist/qwbe-cli.js" : "../src/qwbe-cli.ts")
main(process.argv.slice(2))
