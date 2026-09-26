/** The package name of the copy, and the cube name inside it. */
export const PKG = "lifecycle-plugin"
export const PKG_CUBE = "lifebookmarks"

export const MANIFEST = {
  name: PKG,
  kind: "plugin",
  summary: "renamed copy of the example bookmarks cube",
  cubes: [PKG_CUBE],
}

// The compound names are parked before the bare rename, so "booktags/bookmarks" does not become
// "booktags/lifebookmarks" and then need a second pass.
const renameNames = (source: string) =>
  source
    .replaceAll("booktags/bookmarks:", "PPP_COLON")
    .replaceAll("booktags/bookmarks.created", "PPP_EVENT")
    .replaceAll("bookmarks", PKG_CUBE)
    .replaceAll(`"booktags/${PKG_CUBE}"`, `"${PKG_CUBE}"`)
    .replaceAll('"settings-cache"', `"${PKG_CUBE}-cache"`)
    .replaceAll("PPP_COLON", `${PKG_CUBE}:`)
    .replaceAll("PPP_EVENT", `${PKG_CUBE}.created`)

// A standalone cube has no parent and no sibling: the sibling-contract import goes, and its
// decode is inlined as the shape it checks.
const dropParent = (source: string) =>
  source
    .replace(/^\s*import \{ decodeBooktagsSettingChanged \} from "\.\.\/events\.ts"\n/m, "")
    .replaceAll("decodeBooktagsSettingChanged(payload)", "payload as { key: string; value: string }")
    .replace(/^\s*parent: "booktags",\n/m, "")

/** Pure: the example bookmarks cube source rewritten into a standalone cube named PKG_CUBE. */
export const renameBookmarks = (source: string) => dropParent(renameNames(source))
