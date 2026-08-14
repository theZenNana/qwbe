"use client"

import { useCallback, useEffect, useState } from "react"
import {
  addPermissionGroupMember,
  assignPermissionCubeAdmin,
  catalogue,
  createPermissionGroup,
  type PermissionGroup,
  permissionAudit,
  permissionCubeAdmins,
  permissionGroups,
} from "../../lib/api.ts"
import type { AuditEvent, CubeAdmin } from "../../lib/contracts.ts"

export default function PermissionsPage() {
  const [cube, setCube] = useState("")
  const [cubes, setCubes] = useState<ReadonlyArray<string>>([])
  const [admins, setAdmins] = useState<ReadonlyArray<CubeAdmin>>([])
  const [groups, setGroups] = useState<ReadonlyArray<PermissionGroup>>([])
  const [audit, setAudit] = useState<ReadonlyArray<AuditEvent>>([])
  const [groupName, setGroupName] = useState("")
  const [adminUsername, setAdminUsername] = useState("")
  const [member, setMember] = useState("")
  const [selectedGroup, setSelectedGroup] = useState("")
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback((selected: string) => {
    if (!selected) return
    setError(null)
    Promise.all([permissionCubeAdmins(selected), permissionGroups(selected), permissionAudit()])
      .then(([nextAdmins, nextGroups, events]) => {
        setAdmins(nextAdmins)
        setGroups(nextGroups)
        setAudit(events.rows)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [])

  useEffect(() => {
    catalogue()
      .then((items) => {
        const names = items.filter((item) => item.entityPermissions).map((item) => item.name)
        setCubes(names)
        const first = names[0] ?? ""
        setCube(first)
        refresh(first)
      })
      .catch((cause: Error) => setError(cause.message))
  }, [refresh])

  return (
    <>
      <h2>Permissions</h2>
      {error && <div className="eroare">{error}</div>}
      <label>
        Cube{" "}
        <select
          value={cube}
          onChange={(event) => {
            setCube(event.target.value)
            refresh(event.target.value)
          }}
        >
          {cubes.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <h3>Cube admins</h3>
      <ul>
        {admins.map((admin) => (
          <li key={admin.id}>{admin.userId}</li>
        ))}
      </ul>
      <div className="share-inline">
        <input
          aria-label="Cube admin @username"
          value={adminUsername}
          onChange={(event) => setAdminUsername(event.target.value)}
        />
        <button
          type="button"
          disabled={!adminUsername}
          onClick={() =>
            void assignPermissionCubeAdmin(cube, adminUsername.replace(/^@/, "")).then(() => {
              setAdminUsername("")
              refresh(cube)
            })
          }
        >
          Assign
        </button>
      </div>
      <h3>Groups</h3>
      <div className="share-inline">
        <input aria-label="Nume grup" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
        <button
          type="button"
          onClick={() =>
            void createPermissionGroup(cube, groupName).then(() => {
              setGroupName("")
              refresh(cube)
            })
          }
        >
          Create
        </button>
      </div>
      <div className="share-inline">
        <select aria-label="Grup" value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}>
          <option value="">grup</option>
          {groups.map((group) => (
            <option value={group.id} key={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <input aria-label="Membru @username" value={member} onChange={(event) => setMember(event.target.value)} />
        <button
          type="button"
          disabled={!selectedGroup || !member}
          onClick={() =>
            void addPermissionGroupMember(selectedGroup, member.replace(/^@/, "")).then(() => setMember(""))
          }
        >
          Add member
        </button>
      </div>
      <h3>Audit</h3>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>actor</th>
            <th>cube</th>
            <th>action</th>
            <th>result</th>
            <th>trace</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((event) => (
            <tr key={event.id}>
              <td>{event.timestamp}</td>
              <td>{event.actorUserId}</td>
              <td>{event.cube}</td>
              <td>{event.action}</td>
              <td>{event.result}</td>
              <td>{event.traceId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
