NOT A CUBE. This directory exists so the discovery probe can prove a parent may hold
non-cube directories next to its children -- assets/, fixtures/, migrations/ -- without
the kernel trying to import them. There is deliberately no index.ts here; scan.ts skips
any directory that does not export a cube.
