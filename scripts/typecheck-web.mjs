// Poarta de tipuri pentru `web/` — cu grija de a spune CE lipsește, nu doar că e roșu.
//
// `tsc -p web/tsconfig.json` fără `web/node_modules` instalat dă 21 de erori, din care doar 4
// sunt „Cannot find module". Celelalte 12 sunt derivate — `badge.tsx` nu poate importa `cva`,
// deci `BadgeProps` iese fără `variant`, deci fiecare folosire pică separat cu
// „Property 'variant' does not exist". Lista aia arată exact ca datorie de cod, și trimite
// omul să repare tipuri când cauza e o instalare nerulată.
//
// Măsurat pe 3 aug: patru module lipsă produc șaisprezece erori, iar douăsprezece dintre ele
// mint despre cauză. De-aia poarta întreabă întâi de director și abia apoi rulează `tsc`.
//
// `web/node_modules` e PER ARBORE — într-un repo cu mai multe worktree-uri, instalarea altuia
// nu te ajută. Cele cinci dependențe (`clsx`, `tailwind-merge`, `class-variance-authority`,
// `tailwindcss`, `@tailwindcss/postcss`) sunt în `web/package-lock.json`, comis; deci
// `npm ci --prefix web` e determinist și suficient.

// DE CE `npm ls` ȘI NU `test -d node_modules`, NICI `npm ci` — cele trei variante, măsurate:
//
//   test -d node_modules   0s   verifică un SIMPTOM: trece și cu o instalare veche, dintr-un
//                               lock de acum trei zile. Exact felul de verde care ne-a costat.
//   npm ci --prefix web    2s cald / 17s rece, 153 MB   impune starea — dar ȘTERGE tot
//                               `node_modules` și îl rescrie. Cine are `next dev` pornit
//                               rămâne fără el sub picioare, în mijlocul rulării altcuiva.
//   npm ls --depth=0       0s   întreabă dacă ce e instalat CORESPUNDE declarației,
//                               fără să scrie nimic. Probat: cu `clsx` scos, exit 1 și
//                               „UNMET DEPENDENCY clsx@^2.1.1".
//
// Limita lui, scrisă ca să nu pară mai mult decât e: verifică dependențele DIRECTE față de
// `package.json`, nu tot arborele din lock. Prinde „lipsește" și „altă versiune sus"; n-ar
// prinde o derivă tranzitivă adâncă. E strict mai mult decât `test -d` și nu distruge nimic.

import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const instalat = spawnSync("npm", ["ls", "--prefix", "web", "--depth=0"], { cwd: root, encoding: "utf8" })
if (instalat.status !== 0) {
  console.error("web/node_modules lipsește sau nu corespunde — rulează:  npm ci --prefix web")
  console.error("(fără el, tsc raportează 21 de erori de tip pentru 4 module lipsă)")
  const lipsa = (instalat.stdout ?? "").match(/UNMET DEPENDENCY \S+/g) ?? []
  for (const l of lipsa.slice(0, 5)) console.error(`  ${l}`)
  process.exit(1)
}

const r = spawnSync("npx", ["tsc", "--noEmit", "-p", "web/tsconfig.json"], { cwd: root, encoding: "utf8" })
process.stdout.write(r.stdout ?? "")
process.stderr.write(r.stderr ?? "")
process.exit(r.status ?? 1)
