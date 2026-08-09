// THE SESSION HALF OF AUTHENTICATION — the part that lives with the frontend.
//
// The split asked for: the backend `auth` cube issues and validates tokens; this file owns
// everything that happens in the browser — storing the token, attaching it to requests, knowing
// when it has expired, and getting a person back to the login screen.
//
// Keeping it here rather than in the API client is deliberate. Every screen in this app is
// generic and draws itself from metadata; the session is the one piece of genuine application
// state, and it should be findable in one file rather than spread across pages.
//
// Storage is `localStorage`, which is the prototype shortcut and worth naming: a real system
// puts the token in an httpOnly cookie so JavaScript cannot read it, with CSRF protection at
// the gateway. That is a change to this file and the gateway, not to any cube.

const KEY = "cubes-session"

export type Session = {
  readonly token: string
  readonly expiresAt: string
}

export const session = {
  read(): Session | null {
    if (typeof window === "undefined") return null
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    try {
      const s = JSON.parse(raw) as Session
      // An expired token is the same as no token. Checking here means a stale tab shows the
      // login screen instead of a page full of 401s.
      if (new Date(s.expiresAt).getTime() <= Date.now()) {
        window.localStorage.removeItem(KEY)
        return null
      }
      return s
    } catch {
      return null
    }
  },

  write(s: Session): void {
    window.localStorage.setItem(KEY, JSON.stringify(s))
  },

  clear(): void {
    window.localStorage.removeItem(KEY)
  },

  headers(): Record<string, string> {
    const s = session.read()
    return s ? { authorization: `Bearer ${s.token}` } : {}
  },
}

/** Called when the API says 401 mid-session: drop the token and go back to the door. */
export const endSession = (): void => {
  session.clear()
  if (typeof window !== "undefined") window.location.href = "/"
}
