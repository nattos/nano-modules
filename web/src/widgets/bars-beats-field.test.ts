// @vitest-environment happy-dom
/**
 * Component tests for <bars-beats-field>: per-segment jogging (with carry),
 * inline segment editing, and whole-value double-click editing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import './bars-beats-field';
import type { BarsBeatsField } from './bars-beats-field';

async function mount(props: Partial<BarsBeatsField> = {}): Promise<BarsBeatsField> {
  const el = document.createElement('bars-beats-field') as BarsBeatsField;
  Object.assign(el, { value: 0, beatsPerBar: 4, sixPerBeat: 4, ...props });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}
function segs(el: BarsBeatsField) {
  return Array.from(el.renderRoot.querySelectorAll('.seg')) as HTMLElement[];
}
function segKey(el: BarsBeatsField, i: number, key: string, opts: KeyboardEventInit = {}) {
  segs(el)[i].dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}
async function editInput(el: BarsBeatsField): Promise<HTMLInputElement> {
  await el.updateComplete;
  const et = el.renderRoot.querySelector('editable-text') as
    (HTMLElement & { updateComplete: Promise<unknown>; renderRoot: ParentNode });
  await et.updateComplete;
  return et.renderRoot.querySelector('input') as HTMLInputElement;
}

describe('<bars-beats-field>', () => {
  let el: BarsBeatsField;
  afterEach(() => { el?.remove(); });

  it('renders three 1-based segments for the beat value', async () => {
    el = await mount({ value: 17 }); // bar 5, beat 2, six 1
    expect(segs(el).map((s) => s.textContent)).toEqual(['5', '2', '1']);
  });

  it('jogs each segment by its own musical amount, emitting beats', async () => {
    el = await mount({ value: 0 });
    const onInput = vi.fn();
    el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
    segKey(el, 0, 'ArrowUp'); // +1 bar = +4 beats
    expect(el.value).toBe(4);
    segKey(el, 1, 'ArrowUp'); // +1 beat
    expect(el.value).toBe(5);
    segKey(el, 2, 'ArrowUp'); // +1 sixteenth = +0.25 beat
    expect(el.value).toBe(5.25);
    expect(onInput).toHaveBeenLastCalledWith(5.25);
  });

  it('Left/Right move focus between segments (they do not jog)', async () => {
    el = await mount({ value: 17 });
    const before = el.value;
    const s = segs(el);
    const focused = () => (el.renderRoot as ShadowRoot).activeElement;
    s[0].focus();
    s[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(focused()).toBe(s[1]); // moved to the beat segment
    expect(el.value).toBe(before); // no jog
    s[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(focused()).toBe(s[2]);
    s[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(focused()).toBe(s[2]); // clamped at the last
    s[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(focused()).toBe(s[1]);
  });

  it('jogging a segment past its bound carries into the neighbour', async () => {
    el = await mount({ value: 3.75 }); // bar1 beat4 six4
    expect(segs(el).map((s) => s.textContent)).toEqual(['1', '4', '4']);
    segKey(el, 2, 'ArrowUp'); // +1 sixteenth → 4.0 beats → bar2 beat1 six1
    expect(el.value).toBe(4);
    await el.updateComplete;
    expect(segs(el).map((s) => s.textContent)).toEqual(['2', '1', '1']);
  });

  it('clamps at min (0) when jogging down', async () => {
    el = await mount({ value: 0 });
    segKey(el, 1, 'ArrowDown');
    expect(el.value).toBe(0);
  });

  it('typing a digit edits that segment inline and recomposes', async () => {
    el = await mount({ value: 0 }); // 1.1.1
    // Edit the beat segment → 6, which carries (beat 6 in 4/4 ⇒ bar 2 beat 2).
    segKey(el, 1, '6');
    const input = await editInput(el);
    expect(input.value).toBe('6');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.value).toBe(5);
    await el.updateComplete;
    expect(segs(el).map((s) => s.textContent)).toEqual(['2', '2', '1']);
  });

  it('double-click edits the whole value as bar.beat.sixteenth', async () => {
    el = await mount({ value: 0 });
    const onInput = vi.fn();
    el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
    segs(el)[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await editInput(el);
    expect(input.value).toBe('1.1.1');
    input.value = '5.2.1';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.value).toBe(17);
    expect(onInput).toHaveBeenLastCalledWith(17);
  });

  it('length mode shows duration components (one bar = 1.0.0)', async () => {
    el = await mount({ value: 4, length: true }); // exactly one bar
    expect(segs(el).map((s) => s.textContent)).toEqual(['1', '0', '0']);
    // Whole-edit round-trips in duration format.
    segs(el)[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await editInput(el);
    expect(input.value).toBe('1.0.0');
    input.value = '2.1.0';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.value).toBe(9); // 2 bars + 1 beat
  });

  it('Escape cancels a whole edit without changing the value', async () => {
    el = await mount({ value: 17 });
    segs(el)[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await editInput(el);
    input.value = '99.1.1';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.value).toBe(17);
  });
});
