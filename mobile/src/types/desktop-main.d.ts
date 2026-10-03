/**
 * Type stand-in for the desktop renderer entry (`upstream/apps/desktop/src/main.tsx`).
 *
 * entry.ts imports it dynamically for its side effects only. Mapping `@/main` to
 * this empty module in tsconfig keeps `tsc -p mobile` focused on the bridge
 * (which IS checked against upstream's global.d.ts) instead of re-typechecking
 * the whole renderer under a second toolchain; the renderer is compiled by Vite.
 */
export {}
