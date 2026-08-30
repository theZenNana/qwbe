// The "install from a directory" card on the install page.
//
// Split out of `page.tsx` when QWB-15's form pushed that file further past its cap - the page
// was already the repo's largest file, and the card is a self-contained unit: one input, one
// button, one API call. The parent keeps the state (the value lives there because `busy`
// disables it alongside every other control on the page) and hands down the `run` wrapper that
// measures the before/after effect.
//
// The scan picker that reuses this input as a ROOT lives in `InstallScan.tsx` - split out the
// day the multi-select arrived, for the same cap this file was split out for.

"use client"

import { installFromDirectory } from "../../lib/packages-api"
import { kb } from "../../lib/utils"
import { InstallScan } from "./InstallScan"

export const InstallFromCard = ({
  sourcePath,
  setSourcePath,
  busy,
  run,
}: {
  sourcePath: string
  setSourcePath: (v: string) => void
  busy: string | null
  run: (
    key: string,
    call: () => Promise<{ title: string; explanation: string; requiresRestart: boolean; log: Array<string> }>,
  ) => Promise<void>
}) => (
  <div className="inst-card">
    <div className="inst-nume">Instalează dintr-un director</div>
    <div className="inst-detaliu">
      Cale ABSOLUTĂ pe server. Un director cu <span className="mono">qwbe-package.json</span> se instalează direct; un
      director-PĂRINTE se scanază — bifezi pachetele găsite și le instalezi pe toate odată. Kernelul copiază în magazin
      și instalează de acolo — nimic nu se execută din directorul sursă, iar după repornire codul copiat RULEAZĂ în
      server.
    </div>
    <div className="inst-actiuni">
      <input
        type="text"
        className="inst-input"
        data-cale-sursa
        placeholder="/cale/absoluta/spre/plugin sau /cale/parinte"
        value={sourcePath}
        onChange={(e) => setSourcePath(e.target.value)}
        disabled={busy !== null}
      />
      <button
        type="button"
        className="inst-primar"
        data-instaleaza-director
        disabled={busy !== null || sourcePath.trim() === ""}
        onClick={() =>
          run(sourcePath, async () => {
            const r = await installFromDirectory(sourcePath.trim())
            return {
              title: `${r.package.kind === "plugin" ? "Plugin" : "Cub"} instalat din director: ${r.package.name}`,
              explanation:
                `Directorul a fost validat, copiat în magazin ` +
                `(${r.staged ? "copie nouă" : "copie identică deja în magazin — reutilizată"}) ` +
                `și instalat. Nimic nu s-a executat din sursă. Ce aduce (${r.package.cubes.join(", ")}) ` +
                `apare după repornirea API-ului.`,
              requiresRestart: r.requiresRestart,
              log: [
                `POST /settings/packages/install-from {path} → 200`,
                `copiat ${kb(r.package.bytes)} — aduce: ${r.package.cubes.join(", ")}`,
                `staged: ${r.staged} — requiresRestart: ${r.requiresRestart}`,
              ],
            }
          })
        }
      >
        instalează din director
      </button>
    </div>

    <InstallScan sourcePath={sourcePath} busy={busy} run={run} />
  </div>
)
