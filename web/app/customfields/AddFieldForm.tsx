"use client"

// The add-a-field form of the customfields screen, split out of page.tsx (file cap): the
// page keeps the state and the API calls, this file keeps only what a form looks like.

import type { CubeInfo } from "../../lib/api"
import type { FieldType } from "../../lib/customfields-api"

const TYPES: Array<FieldType> = ["text", "number", "date", "bool", "select"]

export function AddFieldForm({
  cubes,
  targetCube,
  setTargetCube,
  name,
  setName,
  label,
  setLabel,
  fieldType,
  setFieldType,
  options,
  setOptions,
  required,
  setRequired,
  busy,
  onAdd,
}: {
  cubes: Array<CubeInfo>
  targetCube: string
  setTargetCube: (v: string) => void
  name: string
  setName: (v: string) => void
  label: string
  setLabel: (v: string) => void
  fieldType: FieldType
  setFieldType: (v: FieldType) => void
  options: string
  setOptions: (v: string) => void
  required: boolean
  setRequired: (v: boolean) => void
  busy: boolean
  onAdd: () => void
}) {
  return (
    <div className="panou">
      <h3>Add a field</h3>
      <table>
        <tbody>
          <tr>
            <td style={{ width: 180, color: "var(--sters)" }}>cube</td>
            <td>
              <select data-testid="cf-cube" value={targetCube} onChange={(e) => setTargetCube(e.target.value)}>
                <option value="">-- pick a cube --</option>
                {cubes.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.plugin ? ` (${c.plugin})` : ""}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <td style={{ color: "var(--sters)" }}>name</td>
            <td>
              <input
                data-testid="cf-name"
                value={name}
                placeholder="cnp"
                onChange={(e) => setName(e.target.value)}
                style={{ width: "100%" }}
              />
              <div className="mic">
                a letter, then letters, digits or underscores -- it is the key the value is stored under
              </div>
            </td>
          </tr>
          <tr>
            <td style={{ color: "var(--sters)" }}>label</td>
            <td>
              <input
                data-testid="cf-label"
                value={label}
                placeholder="CNP"
                onChange={(e) => setLabel(e.target.value)}
                style={{ width: "100%" }}
              />
              <div className="mic">what the form shows. Empty means the name is used.</div>
            </td>
          </tr>
          <tr>
            <td style={{ color: "var(--sters)" }}>type</td>
            <td>
              <select
                data-testid="cf-type"
                value={fieldType}
                onChange={(e) => setFieldType(e.target.value as FieldType)}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          {fieldType === "select" && (
            <tr>
              <td style={{ color: "var(--sters)" }}>options</td>
              <td>
                <input
                  data-testid="cf-options"
                  value={options}
                  placeholder="junior, mid, senior"
                  onChange={(e) => setOptions(e.target.value)}
                  style={{ width: "100%" }}
                />
                <div className="mic">comma separated. A value outside this list is refused by the API.</div>
              </td>
            </tr>
          )}
          <tr>
            <td style={{ color: "var(--sters)" }}>required</td>
            <td>
              <input
                data-testid="cf-required"
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              <span className="mic"> a required field cannot be emptied once it has a value</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div className="rand-paginare">
        <button type="button" data-testid="cf-add" disabled={busy || !targetCube || !name} onClick={onAdd}>
          {busy ? "adding..." : "add field"}
        </button>
        <span className="mic">the new field shows up on every row of that cube, at once</span>
      </div>
    </div>
  )
}
