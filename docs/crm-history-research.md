# Historical CRM pack inventory

Date: 2026-08-12

## Finding

The removed CRM package contained exactly two cubes: `contacts` and `contracts`.
Its preserved local source is `~/Projects/qwbe-packs/plugins/crm-pack` and its
installable shelf copy is `~/Projects/qwbe-packs/store/crm-pack`.

The separate historical ERP package contained `accounts`, a different and richer `contacts`
cube, and `erp-settings`. Those modules are not part of the historical CRM package and should
not be silently folded into the CRM restoration.

## Primary evidence

- Commit `3e87c3b2afc594697346e878dafe82224cca1da0` removed
  `core/plugins/crm-pack/cubes/contacts/index.ts` and
  `core/plugins/crm-pack/cubes/contracts/index.ts` from Qwbe while moving non-core packs out.
- The same commit separately removed `core/store/erp-pack/cubes/accounts/index.ts`,
  `contacts/index.ts`, and `erp-settings/index.ts`.
- `~/Projects/qwbe-packs/README.md` records the 2026-08-10 move and identifies the
  backup as the source for restoring the packages.
- `~/Projects/qwbe-packs/store/crm-pack/qwbe-package.json` declares
  `"cubes": ["contacts", "contracts"]`.
- SHA-256 comparison on 2026-08-12 confirmed that the live and shelf copies of each CRM cube
  are byte-identical.

## Historical CRM behavior

`contacts` owns `Contact` records with name, email, phone, and company fields. It exposes list,
get, and create operations, permissions, summaries, and a `contacts.created` event.

`contracts` owns `Contract` records with title, monetary amount in minor units, currency,
signature date, and nullable `partyId`. It exposes list, get, and create operations, permissions,
summaries, commands, and a `contracts.created` event. The cube stores only the other party's ID;
it does not import the contacts cube.

The old CRM model does not contain a first-class company/account entity. `Contact.company` is a
nullable string, while `Contract.partyId` is an untyped cross-entity identifier. A proper CRM
account/contact relationship therefore requires a design decision rather than copying an old
CRM module that did not exist.

## Compatibility note

The preserved code imports private kernel paths and uses the pre-QWB-19 `CubeDefinition` shape.
It is historical source material, not directly installable against the current typed public
plugin contract without adaptation and contract tests.

## Verification commands

```sh
git log --all --name-status -- core/plugins/crm-pack core/store/crm-pack core/store/erp-pack
sha256sum ~/Projects/qwbe-packs/plugins/crm-pack/cubes/*/index.ts \
  ~/Projects/qwbe-packs/store/crm-pack/cubes/*/index.ts
sh ~/Projects/qwbe-packs/verify.sh
```
