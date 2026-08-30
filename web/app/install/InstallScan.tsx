// The directory-scan picker on the install page: the multi-select the owner asked for
// ("I should be able to select, like a UI multiple select").
//
// Split out of `InstallFromCard.tsx` for the per-file size cap on the day it was written; the
// seam is the natural one - the card keeps the path input and the direct install, this file
// keeps everything that treats the path as a ROOT to scan. One server-side read-only pass
// lists the packages under it, native checkboxes pick them, one click installs them in
// sequence, each through the same `run` wrapper the rest of the page uses - so every install
// is measured before/after and lands in the journal like any other operation.
//
// A candidate whose store copy differs from its source is replaced in one click (uninstall ->
// forget shelf -> install): the QWB-15 refusals made that loop impossible from the UI alone.
// Nothing here installs anything the kernel would refuse - the kernel's own wording reaches
// the journal untouched.

"use client"

import { useState } from "react"
import type { ScannedPackage } from "../../lib/contracts"
import { forgetShelf, installFromDirectory, scanPackages, uninstallPackage } from "../../lib/packages-api"
import { kb } from "../../lib/utils"

const shelfPill = (shelf: ScannedPackage["shelf"]) =>
  shelf === "identical" ? "copie identică în magazin" : shelf === "different" ? "copie DIFERITĂ în magazin" : ""

export const InstallScan = ({
  sourcePath,
  busy,
  run,
}: {
  sourcePath: string
  busy: string | null
  run: (
    key: string,
    call: () => Promise<{ title: string; explanation: string; requiresRestart: boolean; log: Array<string> }>,
  ) => Promise<void>
}) => {
  const [candidates, setCandidates] = useState<Array<ScannedPackage> | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())

  const toggle = (name: string) =>
    setPicked((old) => {
      const next = new Set(old)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  const scan = async () => {
    setScanning(true)
    setScanError(null)
    try {
      const r = await scanPackages(sourcePath.trim())
      setCandidates([...r.packages])
      // Default selection: everything the kernel could actually install right now.
      setPicked(new Set(r.packages.filter((p) => !p.installed && p.conflicts.length === 0).map((p) => p.name)))
    } catch (e) {
      setCandidates(null)
      setScanError((e as Error).message)
    } finally {
      setScanning(false)
    }
  }

  const installPicked = async () => {
    const list = (candidates ?? []).filter((p) => picked.has(p.name))
    for (const p of list) {
      await run(`instalează ${p.name}`, async () => {
        // A differing shelf copy would make install-from refuse; replace it first. An
        // installed package never reaches this loop - its checkbox is disabled below.
        if (p.shelf === "different") {
          await uninstallPackage(p.name)
          await forgetShelf(p.name)
        }
        const r = await installFromDirectory(p.path)
        return {
          title: `${r.package.kind === "plugin" ? "Plugin" : "Cub"} instalat: ${r.package.name}`,
          explanation:
            `Copiat în magazin ` +
            `${r.staged ? "(copie nouă)" : "(copie identică reutilizată)"} și instalat. ` +
            `Ce aduce (${r.package.cubes.join(", ")}) apare după repornirea API-ului.`,
          requiresRestart: r.requiresRestart,
          log:
            p.shelf === "different"
              ? [
                  `înlocuit copia din magazin: uninstall + forget shelf + install-from`,
                  `copiat ${kb(r.package.bytes)} — aduce: ${r.package.cubes.join(", ")}`,
                ]
              : [
                  `POST /settings/packages/install-from {path} → 200`,
                  `copiat ${kb(r.package.bytes)} — aduce: ${r.package.cubes.join(", ")}`,
                  `staged: ${r.staged} — requiresRestart: ${r.requiresRestart}`,
                ],
        }
      })
    }
  }

  return (
    <>
      <div className="inst-actiuni">
        <button
          type="button"
          data-cauta-pachete
          disabled={busy !== null || scanning || sourcePath.trim() === ""}
          onClick={scan}
        >
          {scanning ? "se caută…" : "caută pachete sub calea de mai sus"}
        </button>
      </div>

      {scanError && (
        <div className="mic" style={{ color: "var(--reau, #b3261e)" }}>
          scanare refuzată: {scanError}
        </div>
      )}

      {candidates !== null && candidates.length === 0 && (
        <div className="gol">niciun pachet aici — niciun subdirector cu qwbe-package.json</div>
      )}

      {candidates !== null && candidates.length > 0 && (
        <>
          <div className="inst-actiuni" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="inst-primar"
              data-instaleaza-selectate
              disabled={busy !== null || picked.size === 0}
              onClick={installPicked}
            >
              instalează selectate ({picked.size})
            </button>
          </div>
          {candidates.map((p) => {
            const blocked = p.installed || p.conflicts.length > 0
            const note = p.installed
              ? "deja instalat"
              : p.conflicts.length > 0
                ? `conflict pe disc: ${p.conflicts.join(", ")}`
                : shelfPill(p.shelf)
            return (
              <label key={p.name} className="inst-alege" data-alege={p.name}>
                <input
                  type="checkbox"
                  checked={picked.has(p.name)}
                  disabled={busy !== null || blocked}
                  onChange={() => toggle(p.name)}
                />
                <span>
                  <b className="mono">{p.name}</b> <span className="inst-sursa">{p.kind}</span>{" "}
                  <span className="inst-sursa">{kb(p.bytes)}</span>
                  {note && <span className="mic"> — {note}</span>}
                  <div className="mic">{p.summary || "fără descriere"}</div>
                  <div className="mic mono">aduce: {p.cubes.join(", ")}</div>
                </span>
              </label>
            )
          })}
        </>
      )}
    </>
  )
}
