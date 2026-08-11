"use client"

// THE SHELL. The sidebar is drawn from the CATALOGUE, never from a list of routes in code.
//
// This is the frontend half of the invariant: a new directory appears in the backend and a tab
// appears here -- no build, no line changed. Switch a cube off and its tab goes grey. Nowhere in
// this whole app is the word "notes" or "account" written.
//
// Cubes that arrived in a plugin are marked, because "where did this come from" is the first
// question anyone asks when a tab they do not recognise shows up.

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type ReactNode, useEffect, useState } from "react"
import { type CubeInfo, catalogue, leafName, logout, screenPath } from "../lib/api"
import { session } from "../lib/session"

export function Shell({ children }: { children: ReactNode }) {
  const [cubes, setCubes] = useState<Array<CubeInfo> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const path = usePathname()

  // `path` nu e citit în efect, e DECLANȘATORUL lui. Catalogul se reia la fiecare navigare, ca
  // bara să arate starea de acum: stingi un cub în `/settings`, treci pe altă pagină, pastila
  // lui e deja gri. Autofix-ul regulii ar scoate `path`, iar catalogul s-ar citi o singură dată,
  // la montare — bara ar rămâne cu o fotografie veche până la un refresh de browser.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependența e declanșatorul, nu o citire
  useEffect(() => {
    if (!session.read()) return
    catalogue()
      .then(setCubes)
      .catch((e: Error) => setError(e.message))
  }, [path])

  // Cubes holding an entity get the generic list screen; a cube may also declare `screen` for
  // one of its own (`projects` owns no table, but its screen is the whole cube). The rest
  // (auth, links, settings, cli) are infrastructure -- they have nothing to show.
  //
  // Children are NOT listed flat: they are drawn under their parent (docs/booktags-hierarchy.md
  // section 6) -- one sidebar entry per hierarchy, not one per module.
  const withScreen = (cubes ?? []).filter((c) => (c.entity || c.screen) && !c.parent)
  const infrastructure = (cubes ?? []).filter((c) => !c.entity && !c.screen && !c.parent)
  const childrenOf = (name: string) => (cubes ?? []).filter((c) => c.parent === name)

  const tabFor = (c: CubeInfo) => (
    <Link
      key={c.name}
      href={screenPath(c)}
      className={`tab ${path === screenPath(c) ? "activ" : ""} ${c.enabled ? "" : "stins"}`}
    >
      {/* The name is its own element rather than a bare text node, so it can be
          addressed exactly -- by a test, or by anything else reading the DOM. */}
      <span>
        <span data-cube={c.name}>{leafName(c.name)}</span>
        {c.plugin && <span className="mic"> - plugin</span>}
      </span>
      <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "on" : "off"}</span>
    </Link>
  )

  return (
    <div className="cadru">
      <nav className="bara">
        <h1>Qwbe</h1>
        {cubes === null && <div className="mic">loading…</div>}
        {withScreen.map((c) => {
          const children = childrenOf(c.name)
          return (
            <div key={c.name}>
              {tabFor(c)}
              {children.length > 0 && <div style={{ paddingLeft: 14 }}>{children.map(tabFor)}</div>}
            </div>
          )
        })}

        {infrastructure.length > 0 && (
          <>
            <h1 style={{ marginTop: 18 }}>No screen</h1>
            {infrastructure.map((c) => (
              <div key={c.name} className={`tab ${c.enabled ? "" : "stins"}`}>
                <span>{c.name}</span>
                <span className={`pastila ${c.enabled ? "viu" : "stins"}`}>{c.enabled ? "on" : "off"}</span>
              </div>
            ))}
          </>
        )}

        <h1 style={{ marginTop: 18 }}>System</h1>
        <Link href="/cli" className={`tab ${path === "/cli" ? "activ" : ""}`}>
          terminal
        </Link>
        <Link href="/settings" className={`tab ${path === "/settings" ? "activ" : ""}`}>
          settings
        </Link>
        <Link href="/install" className={`tab ${path === "/install" ? "activ" : ""}`}>
          install
        </Link>
        {/* Buton, nu legătură. Era `<a href="#">` care își anula propriul click — adică un buton
            deghizat: cititoarele de ecran îl anunțau ca legătură, iar fără JavaScript `href="#"`
            te ducea în capul paginii în loc să te scoată din cont. Arată identic; `button.tab`
            din `style.css` îi ia fundalul și bordura de buton și-i lasă forma de tab. */}
        <button
          type="button"
          className="tab"
          onClick={async () => {
            await logout()
            window.location.href = "/"
          }}
        >
          sign out
        </button>
      </nav>

      <main className="continut">
        {error && <div className="eroare">{error}</div>}
        {children}
      </main>
    </div>
  )
}
