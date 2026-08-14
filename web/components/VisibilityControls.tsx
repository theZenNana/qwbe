import type { EntityVisibility, VisibilityView } from "qwbe-core/permissions"
import { useState } from "react"
import type { PermissionGroup } from "../lib/api.ts"
import { visibilityOptions, visibilityPresentation } from "../lib/permissions-ui.ts"

export function VisibilityControls({
  value,
  hiddenCount,
  onChange,
}: {
  readonly value: VisibilityView
  readonly hiddenCount: number
  readonly onChange: (view: VisibilityView) => void
}) {
  return (
    <nav className="filtre-vizibilitate" aria-label="Provenance filters">
      {visibilityOptions(hiddenCount).map((option) => (
        <button
          type="button"
          className={option.value === value ? "activ" : undefined}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          key={option.value}
        >
          {option.label}
        </button>
      ))}
    </nav>
  )
}

export function EntityVisibilityControls({
  value,
  pending,
  onChange,
  groups,
  onShareUser,
  onShareGroup,
}: {
  readonly value: EntityVisibility
  readonly pending: boolean
  readonly onChange: (hidden: boolean) => void
  readonly groups: ReadonlyArray<PermissionGroup>
  readonly onShareUser: (username: string) => Promise<void>
  readonly onShareGroup: (groupId: string, actions: ReadonlyArray<"read">) => Promise<void>
}) {
  const [username, setUsername] = useState("")
  const [groupId, setGroupId] = useState("")
  const presentation = visibilityPresentation(value)
  const hiding = presentation.visibilityAction === "hide"
  return (
    <div className="etichete-provenienta">
      {presentation.badges.map((badge) => (
        <span className="pastila" key={badge}>
          {badge}
        </span>
      ))}
      <button type="button" className="ca-link" disabled={pending} onClick={() => onChange(hiding)}>
        {hiding ? "Hide" : "Unhide"}
      </button>
      <span className="share-inline">
        <input
          aria-label="Share cu @username"
          value={username}
          placeholder="@username"
          onChange={(event) => setUsername(event.target.value)}
        />
        <button
          type="button"
          disabled={pending || username.trim() === ""}
          onClick={() => void onShareUser(username.replace(/^@/, "").trim()).then(() => setUsername(""))}
        >
          TOTAL
        </button>
        {groups.length > 0 && (
          <>
            <select aria-label="Share cu grup" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">grup</option>
              {groups.map((group) => (
                <option value={group.id} key={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || groupId === ""}
              onClick={() => void onShareGroup(groupId, ["read"])}
            >
              READ
            </button>
          </>
        )}
      </span>
    </div>
  )
}
