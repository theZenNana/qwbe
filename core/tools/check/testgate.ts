import { join } from "node:path"
import * as FileSystem from "@effect/platform/FileSystem"
import * as Effect from "effect/Effect"
import { IS_TEST, sourceFiles } from "../../src/package-size.ts"

// Where one unit is one child directory; units are found on disk, never from a list.
const UNIT_HOLDERS = ["core/src/cubes", "core/src/spaces"]
const PACK_HOLDERS = ["core/plugins", "core/store"]
const SINGLE_UNITS = ["core/src/kernel", "core/src/pg", "core/src/metadata", "core/src/host"]

export const isUntested = (files: ReadonlyArray<string>) =>
  files.length > 0 && !files.some((file) => IS_TEST.test(file))

export const unexcused = (untested: ReadonlyArray<string>, excused: ReadonlyArray<string>) =>
  untested.filter((unit) => !excused.includes(unit))

const isDirectory = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(path)).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  )

const childDirs = (root: string, dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const names = yield* fs.readDirectory(join(root, dir)).pipe(Effect.orElseSucceed((): string[] => []))
    const paths = names
      .filter((name) => !name.startsWith("."))
      .toSorted()
      .map((name) => `${dir}/${name}`)
    return yield* Effect.filter(paths, (path) => isDirectory(join(root, path)))
  })

const childDirsOfAll = (root: string, dirs: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(dirs, (dir) => childDirs(root, dir)),
    (lists) => lists.flat(),
  )

const unitDirs = (root: string) =>
  Effect.gen(function* () {
    const packs = yield* childDirsOfAll(root, PACK_HOLDERS)
    const packCubes = yield* childDirsOfAll(
      root,
      packs.map((pack) => `${pack}/cubes`),
    )
    const cubes = yield* childDirsOfAll(root, UNIT_HOLDERS)
    const singles = (yield* childDirs(root, "core/src")).filter((dir) => SINGLE_UNITS.includes(dir))
    return [...singles, ...cubes, ...packCubes]
  })

const unitFiles = (root: string, unit: string) => sourceFiles(join(root, unit), { includeTests: true })

// Returns the units with source but no test that `excused` does not cover.
export const testgate = (root: string, excused: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const units = yield* unitDirs(root)
    const untested = yield* Effect.filter(units, (unit) => Effect.map(unitFiles(root, unit), isUntested))
    return unexcused(untested, excused)
  })
