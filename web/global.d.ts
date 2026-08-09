// Importurile de CSS ca efect lateral (layout.tsx importă ./style.css și ./globals.css).
// Next le rezolvă la build; pentru `tsc --noEmit -p web/tsconfig.json` — poarta de tipuri
// They must be declared, otherwise the gate reports errors that are not
// din cod, ci din lipsa declarației. Un modul de tipuri, nu o schimbare de cod.
declare module "*.css"
