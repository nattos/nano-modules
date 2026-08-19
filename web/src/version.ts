/**
 * Engine (runtime) version, three-part [major, minor, patch].
 *
 * Stamped onto serialized sketches (Sketch.engineVersion) at save time. A MINOR
 * bump signals a serialization-incompatible change to how sketches are stored —
 * bump it whenever the on-disk sketch shape changes in a non-back-compatible
 * way. Migrations and fallback paths are a later concern; for now this is purely
 * a recorded marker so a future load can detect the mismatch.
 *
 * (Per-effect and per-bundle versions are recorded separately on each instance;
 * see InstanceState.version, sourced from the effect's state::init version and
 * its module's setModuleVersion in host.h.)
 */
// 1.1.0 — sidecar canvas: `ModuleEntry.canvas` partitions the chain and
// `Sketch.execOrder` overrides execution order. Both keys are OMITTED unless a
// sketch actually uses the canvas, so 1.0.0 documents round-trip unchanged; but
// a 1.0.0 build loading a 1.1.0 canvas sketch would treat canvas entries as
// trailing LINEAR effects and let them hijack the pixel path — hence the minor.
export const ENGINE_VERSION: [number, number, number] = [1, 1, 0];

/** Parse a "major.minor.patch" string into a 3-tuple; non-numeric parts → 0. */
export function parseVersion(v: string | null | undefined): [number, number, number] {
  const parts = (v ?? '').split('.').map(n => Number.parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
