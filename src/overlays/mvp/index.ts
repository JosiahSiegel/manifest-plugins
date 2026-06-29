/**
 * MVP overlay package.
 *
 * Re-exports the typed overlay spec so callers can iterate the
 * overlays without importing the manifest module directly. This is
 * the public surface of `src/overlays/mvp/`.
 *
 * Mirrors `src/overlays/mvp/manifest.json` at runtime — both files
 * are the single source of truth for the MVP overlay manifest. The
 * JSON file is consumed by external tools (the pipeline shell, the
 * apply CLI), while the TS file is consumed by the in-process apply
 * orchestrator in `src/apply/mvp-overlay.ts`.
 */
import { MVP_OVERLAY_SPEC, type MvpOverlaySpec } from './manifest';

export { MVP_OVERLAY_SPEC, type MvpOverlaySpec };

/**
 * Convenience alias: `OVERLAY_SPEC` is the canonical name used by the
 * apply orchestrator. Both names point at the same frozen array so
 * imports stay readable regardless of context.
 */
export const OVERLAY_SPEC: readonly MvpOverlaySpec[] = MVP_OVERLAY_SPEC;