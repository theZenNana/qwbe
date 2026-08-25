import type { EntityGrant, EntityVisibility, GrantAction, VisibilityView } from "qwbe-core/permissions"
import { useState } from "react"
import type { PermissionGroup } from "../lib/api.ts"
import {
  canManageGrants,
  grantActionOptions,
  grantLabel,
  visibilityOptions,
  visibilityPresentation,
} from "../lib/permissions-ui.ts"

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
  grants,
  onShareUser,
  onShareGroup,
  onRevoke,
}: {
  readonly value: EntityVisibility
  readonly pending: boolean
  readonly onChange: (hidden: boolean) => void
  readonly groups: ReadonlyArray<PermissionGroup>
  readonly grants: ReadonlyArray<EntityGrant>
  readonly onShareUser: (username: string, actions?: ReadonlyArray<GrantAction>) => Promise<void>
  readonly onShareGroup: (groupId: string, actions: ReadonlyArray<GrantAction>) => Promise<void>
  readonly onRevoke: (grant: EntityGrant) => Promise<void>
}) {
  const [username, setUsername] = useState("")
  const [groupId, setGroupId] = useState("")
  const [actions, setActions] = useState<ReadonlyArray<GrantAction>>(["read"])
  const presentation = visibilityPresentation(value)
  const hiding = presentation.visibilityAction === "hide"
  const canShare = canManageGrants(value.access.source)
  const toggleAction = (action: GrantAction) =>
    setActions((current) =>
      current.includes(action) ? current.filter((candidate) => candidate !== action) : [...current, action],
    )
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
      {canShare && (
        <div className="granturi-active">
          {grants.map((grant) => (
            <span className="grant-activ" key={grant.id}>
              {grantLabel(grant)}
              <button type="button" className="ca-link" disabled={pending} onClick={() => void onRevoke(grant)}>
                Revoke
              </button>
            </span>
          ))}
        </div>
      )}
      {canShare && (
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
          <fieldset className="grant-actions">
            <legend>Custom grant</legend>
            {grantActionOptions.map((action) => (
              <label key={action}>
                <input type="checkbox" checked={actions.includes(action)} onChange={() => toggleAction(action)} />
                {action}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            disabled={pending || username.trim() === "" || actions.length === 0}
            onClick={() => void onShareUser(username.replace(/^@/, "").trim(), actions).then(() => setUsername(""))}
          >
            CUSTOM
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
                disabled={pending || groupId === "" || actions.length === 0}
                onClick={() => void onShareGroup(groupId, actions)}
              >
                SHARE GROUP
              </button>
            </>
          )}
        </span>
      )}
    </div>
  )
}
