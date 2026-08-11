// LEVEL 1 - the virtual directory.
//
// This directory holds no cube. It holds the CONNECTIONS between cubes, declared by neither
// side. That is the whole idea: `notes` does not know `account` exists, `account` does not know
// `notes` exists, and this file - a third party - says how they relate.
//
// Check it yourself:
//     grep -r Account ../../cubes/notes/    -> nothing
//     grep -r notes   ../../cubes/account/  -> nothing
//
// Delete either cube and this space simply loses a link; the kernel says which one and why,
// at startup, instead of the UI quietly showing an empty list.
//
// Links live outside both modules and are declared with
// `defineLink`. An association is a third thing, not a column one side owns.

import { defineSpace, link } from "../../kernel/space.ts"

export const space = defineSpace({
  name: "workspace",
  title: "Workspace",
  links: [
    // A note points at the account that wrote it. On an account's page this shows up as a
    // "notes" group; on a note's page, as "author".
    link({ from: "notes", field: "authorId", to: "Account", label: "notes" }),
    // A tag points at the bookmark it labels. Both are children of `booktags` now -- and the
    // link STILL lives here, declared by neither side. The hierarchy changed who owns the
    // cubes; it did not change who declares how they connect.
    link({ from: "booktags/tags", field: "bookmarkId", to: "Bookmark", label: "tags" }),
  ],
})
