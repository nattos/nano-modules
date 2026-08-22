/**
 * `control.artnet` per-instance field visibility.
 *
 * The card declares 16 channel outputs because a schema is published once per
 * module TYPE — arity has to be a VALUE, not a shape. `channel_count` picks how
 * many are live, and that resolves per instance: two cards watching different
 * universes with different widths must not affect each other.
 *
 * Registered as a SYNCHRONOUS rule (the first path in field-visibility.ts) so
 * the card paints the right field set on its first render, with no engine round
 * trip and no layout shift once the instance executes.
 *
 * Sibling of `math-nodes.ts`, which does the same for `input_count`.
 */

import { registerVisibilityRule } from './field-visibility';
import { ARTNET_MAX_FIELDS, ARTNET_MODULE_TYPE } from '../artnet/artnet-lowering';

/** The active channel count from an instance's state, clamped to the schema. */
export function artnetChannelCount(state: Record<string, any> | undefined): number {
  const raw = state?.channel_count;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 4;
  return Math.min(ARTNET_MAX_FIELDS, Math.max(1, n));
}

/**
 * Fields the card hides: every channel past the count, plus `channel_count`
 * itself — like `input_count` it changes the card's SHAPE rather than a value,
 * so it belongs under the gear icon rather than among the parameter rows.
 */
export function artnetHiddenFields(state: Record<string, any> | undefined): string[] {
  const count = artnetChannelCount(state);
  const hidden = ['channel_count'];
  for (let i = count; i < ARTNET_MAX_FIELDS; i++) hidden.push(`ch_${i}`);
  return hidden;
}

registerVisibilityRule(ARTNET_MODULE_TYPE, artnetHiddenFields);
