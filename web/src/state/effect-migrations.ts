/**
 * Upgrade a saved effect instance whose stored state an effect has since
 * redefined (a MINOR version bump: units or range changed).
 *
 * Every sketch instance records the version of the effect that wrote it
 * (`instance.version.effect`); an instance with no version predates versioning
 * and counts as older than every migration. Each migration names the effect
 * and the version it upgrades TO, rewrites the state, and stamps that version,
 * so running it twice is a no-op.
 *
 * LOCK-STEP twin of native/src/sketch/effect_migrations.h, pinned by the
 * shared cases in web/test/fixtures/effect-migration-cases.json. The web runs
 * it on every sketch it ingests (normalizeSketchChains) and on every
 * arrangement it opens (whose devices carry no version — the composition's
 * `migrations` list says which have run); the barrel runs the C++ twin on each
 * sketch it refetches, so a Resolume composition upgrades with no editor.
 */

export type Version = [number, number, number];

interface Migration {
  /** Stable name — what an arrangement records once it has run. */
  id: string;
  moduleType: string;
  /** The effect version the state is at once applied. */
  to: Version;
  /** Rewrites the state; returns a new object when it changes anything. */
  apply(state: Record<string, unknown>): Record<string, unknown>;
}

const MIGRATIONS: readonly Migration[] = [
  {
    // mod.source.lfo 1.2.0: `rate` was a 0..1 knob mapped to 0..10 Hz; it is
    // now Hz itself (0.01..120, log-scaled). 0 stays 0 (a stopped LFO).
    id: 'lfo-rate-hz',
    moduleType: 'mod.source.lfo',
    to: [1, 2, 0],
    apply(state) {
      const r = state.rate;
      return typeof r === 'number' ? { ...state, rate: r * 10 } : state;
    },
  },
];

/** Every migration id — a new arrangement has already "run" them all. */
export const ALL_MIGRATION_IDS: readonly string[] = MIGRATIONS.map((m) => m.id);

const older = (a: Version, b: Version) =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

function recordedVersion(inst: any): Version {
  const e = inst?.version?.effect;
  if (!Array.isArray(e)) return [0, 0, 0];
  return [0, 1, 2].map((i) => (typeof e[i] === 'number' ? e[i] : 0)) as Version;
}

/** Migrate one sketch instance. Returns the SAME object when nothing applied. */
export function migrateInstance<T extends { module_type?: string; state?: any; version?: any }>(
  inst: T,
): T {
  if (!inst || typeof inst !== 'object') return inst;
  const from = recordedVersion(inst);
  let at = from;
  let state = (inst.state ?? {}) as Record<string, unknown>;
  for (const m of MIGRATIONS) {
    if (inst.module_type !== m.moduleType || !older(at, m.to)) continue;
    state = m.apply(state);
    at = m.to;
  }
  if (at === from) return inst;
  const version = inst.version && typeof inst.version === 'object'
    ? { ...inst.version, effect: [...at] }
    : { module: [0, 0, 0], effect: [...at] };
  const out: any = { ...inst, version };
  if (inst.state !== undefined) out.state = state;
  return out;
}

/** Migrate every instance of a sketch's `instances` map. Same object when unchanged. */
export function migrateInstances<M extends Record<string, any> | undefined>(instances: M): M {
  if (!instances || typeof instances !== 'object') return instances;
  let out: Record<string, any> | null = null;
  for (const [k, inst] of Object.entries(instances)) {
    const next = migrateInstance(inst);
    if (next !== inst) (out ??= { ...instances })[k] = next;
  }
  return (out ?? instances) as M;
}

/**
 * Migrate one arrangement device's state for the migrations `pending` names
 * (the ones its composition hasn't run). Devices carry no version, so the
 * composition-level list decides. Returns the same object when unchanged.
 */
export function migrateDeviceState(
  moduleType: string, state: Record<string, unknown> | undefined, pending: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!state) return state;
  let s = state;
  for (const m of MIGRATIONS) {
    if (m.moduleType === moduleType && pending.has(m.id)) s = m.apply(s);
  }
  return s;
}
