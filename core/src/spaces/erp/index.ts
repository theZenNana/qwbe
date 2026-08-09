// LEVEL 1 — the ERP space. The connection between the two ERP cubes, declared by neither.
//
// `contacts` holds an `accountId` and does not know what it points at; `accounts` does not know
// contacts exist. Check it the same way the workspace space is checked:
//
//     grep -rn "ErpAccount" ../../../plugins/cubes-erp/cubes/contacts/   → nothing
//     grep -rn "contact"    ../../../plugins/cubes-erp/cubes/accounts/   → nothing
//
// 🟡 WHY THIS FILE IS IN CORE AND NOT IN THE PLUGIN — a real limit, not a preference.
//
// `kernel/space.ts` reads spaces from `src/spaces/` only. Cubes are discovered in two places
// (core and `plugins/<p>/cubes/`), spaces in one. So a plugin can bring cubes but cannot bring
// the link between them, and this file has to sit here — the one place where installing this
// plugin adds something outside its own directory. It ADDS a directory rather than editing an
// existing file, so the invariant is bent rather than broken, but it is bent.
//
// The fix is small and belongs to the kernel, not here: have `spaceDirectories()` also walk
// `plugins/<p>/spaces/`, exactly as `discover()` already does for cubes. Left undone on purpose
// — the kernel is not this plugin's to change. Raised for the owner's decision instead.

import { defineSpace, link } from "../../kernel/space.ts"

export const space = defineSpace({
  name: "erp",
  title: "ERP",
  links: [
    // A contact belongs to a company. On the company's page this is a "contacts" list; on the
    // contact's page it is the parent it points at.
    link({ from: "contacts", field: "accountId", to: "ErpAccount", label: "contacts" }),
  ],
})
