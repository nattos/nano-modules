// @vitest-environment happy-dom
/**
 * <scalar-knob> modulation rendering: a binding that reports a modulation band
 * must produce the warm .mod-band/.mod-fill arcs (the rotary twin of
 * scalar-slider's strip) — a midi-wired dashboard knob shows the live wire.
 */
import { describe, it, expect, afterEach } from 'vitest';
import './scalar-knob';
import type { ScalarKnob } from './scalar-knob';
import type { ContinuousEditHandle, FieldBinding } from './field-editor';

const noEdit = (): ContinuousEditHandle => ({ update: () => {}, accept: () => {}, cancel: () => {} });

async function mount(binding: FieldBinding): Promise<ScalarKnob> {
  const el = document.createElement('scalar-knob') as ScalarKnob;
  Object.assign(el, { fieldPath: 'knob_0', min: 0, max: 1, binding });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('<scalar-knob> modulation arcs', () => {
  let el: ScalarKnob;
  afterEach(() => { el?.remove(); });

  it('renders band + fill arcs when the binding reports modulation', async () => {
    el = await mount({
      instanceKey: 'k',
      getValue: () => 0.3,
      setValue: () => {},
      beginContinuousEdit: noEdit,
      getModulation: () => ({ value: 0.8, min: 0.3, max: 1, neutral: 0.3 }),
    });
    expect(el.renderRoot.querySelector('.mod-band')).not.toBeNull();
    expect(el.renderRoot.querySelector('.mod-fill')).not.toBeNull();
  });

  it('renders a fill tick even for a static (zero-width) modulated value', async () => {
    el = await mount({
      instanceKey: 'k',
      getValue: () => 0.3,
      setValue: () => {},
      beginContinuousEdit: noEdit,
      getModulation: () => ({ value: 0.5, min: 0.5, max: 0.5, neutral: 0.5 }),
    });
    expect(el.renderRoot.querySelector('.mod-fill')).not.toBeNull();
  });

  it('renders no arcs without modulation', async () => {
    el = await mount({ instanceKey: 'k', getValue: () => 0.3, setValue: () => {}, beginContinuousEdit: noEdit });
    expect(el.renderRoot.querySelector('.mod-band')).toBeNull();
    expect(el.renderRoot.querySelector('.mod-fill')).toBeNull();
  });
});
