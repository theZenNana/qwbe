"use client"

// The defined-fields table of the customfields screen, split out of page.tsx (file cap),
// grouped per target cube. The remove button disables itself while its own delete is in
// flight, so a double-click cannot send a second DELETE at an already-removed id.

import type { CustomFieldDef } from "../../lib/customfields-api"

export function DefinedFields({
  defs,
  deletingId,
  onDrop,
}: {
  defs: Array<CustomFieldDef> | null
  deletingId: string | null
  onDrop: (d: CustomFieldDef) => void
}) {
  const byCube = (defs ?? []).reduce<Record<string, Array<CustomFieldDef>>>((acc, d) => {
    acc[d.targetCube] = (acc[d.targetCube] ?? []).concat(d)
    return acc
  }, {})

  return (
    <div className="panou">
      <h3>Defined fields</h3>
      {defs === null && <div className="mic">loading...</div>}
      {defs !== null && defs.length === 0 && <div className="gol">No custom fields yet.</div>}
      {Object.entries(byCube).map(([cube, list]) => (
        <div key={cube} style={{ marginBottom: 14 }}>
          <div className="mic" style={{ marginBottom: 6 }}>
            {cube}
          </div>
          <table>
            <tbody>
              {list
                .slice()
                .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
                .map((d) => (
                  <tr key={d.id}>
                    <td style={{ width: 200 }} data-field={`${d.targetCube}.${d.name}`}>
                      {d.label}
                    </td>
                    <td className="mic">
                      {d.name} * {d.fieldType}
                      {d.required ? " * required" : ""}
                      {d.options.length > 0 ? ` * [${d.options.join(" | ")}]` : ""}
                    </td>
                    <td style={{ width: 90 }}>
                      <button type="button" disabled={deletingId === d.id} onClick={() => onDrop(d)}>
                        {deletingId === d.id ? "removing..." : "remove"}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
      <p className="mic">
        Removing a field takes its stored values with it. Defining the same name again starts empty -- an old value
        cannot come back under a new type.
      </p>
    </div>
  )
}
