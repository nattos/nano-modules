// @vitest-environment happy-dom
/**
 * Component tests for <editable-number>: arrow-key jogging, clamping/rounding,
 * type-to-edit, Enter / double-click edit, and the single `input` event.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import './editable-number';
import type { EditableNumber } from './editable-number';

async function mount(props: Partial<EditableNumber> = {}): Promise<EditableNumber> {
  const el = document.createElement('editable-number') as EditableNumber;
  Object.assign(el, { value: 0, step: 1, ...props });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}
function $display(el: EditableNumber) {
  return el.renderRoot.querySelector('.display') as HTMLElement;
}
function key(el: EditableNumber, key: string, opts: KeyboardEventInit = {}) {
  $display(el).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}
async function editInput(el: EditableNumber): Promise<HTMLInputElement> {
  await el.updateComplete;
  const et = el.renderRoot.querySelector('editable-text') as
    (HTMLElement & { updateComplete: Promise<unknown>; renderRoot: ParentNode });
  await et.updateComplete;
  return et.renderRoot.querySelector('input') as HTMLInputElement;
}

describe('<editable-number>', () => {
  let el: EditableNumber;
  afterEach(() => { el?.remove(); });

  it('shows the formatted value with units + step decimals', async () => {
    el = await mount({ value: 120, units: 'bpm' });
    expect($display(el).textContent?.trim()).toBe('120 bpm');
    el.remove();
    el = await mount({ value: 1.5, step: 0.1 });
    expect($display(el).textContent?.trim()).toBe('1.5');
  });

  it('jogs up/right and down/left by step, emitting `input`', async () => {
    el = await mount({ value: 10, step: 2 });
    const onInput = vi.fn();
    el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
    key(el, 'ArrowUp');
    expect(el.value).toBe(12);
    key(el, 'ArrowRight');
    expect(el.value).toBe(14);
    key(el, 'ArrowDown');
    key(el, 'ArrowLeft');
    expect(el.value).toBe(10);
    expect(onInput).toHaveBeenCalledTimes(4);
    expect(onInput).toHaveBeenLastCalledWith(10);
  });

  it('Shift / PageUp use the big step', async () => {
    el = await mount({ value: 0, step: 1 }); // bigStep defaults to step*10
    key(el, 'ArrowUp', { shiftKey: true });
    expect(el.value).toBe(10);
    key(el, 'PageDown');
    expect(el.value).toBe(0);
  });

  it('clamps to [min,max] and rounds to step decimals', async () => {
    el = await mount({ value: 0.95, step: 0.1, min: 0, max: 1 });
    key(el, 'ArrowUp'); // 1.05 → clamp 1
    expect(el.value).toBe(1);
    key(el, 'ArrowUp'); // stays at max (no input emitted)
    expect(el.value).toBe(1);
  });

  it('Home/End jump to finite min/max', async () => {
    el = await mount({ value: 5, min: 1, max: 9 });
    key(el, 'Home');
    expect(el.value).toBe(1);
    key(el, 'End');
    expect(el.value).toBe(9);
  });

  it('type-to-edit seeds the box with the typed digit and commits on Enter', async () => {
    el = await mount({ value: 5 });
    const onInput = vi.fn();
    el.addEventListener('input', (e) => onInput((e as CustomEvent).detail));
    key(el, '4');
    const input = await editInput(el);
    expect(input.value).toBe('4');
    input.value = '42';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(el.value).toBe(42);
    expect(onInput).toHaveBeenLastCalledWith(42);
    await el.updateComplete;
    expect(el.renderRoot.querySelector('editable-text')).toBeNull(); // back to display
  });

  it('double-click edits the current value (parsed + clamped on commit)', async () => {
    el = await mount({ value: 7, min: 0, max: 100 });
    $display(el).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = await editInput(el);
    expect(input.value).toBe('7');
    input.value = '250';
    input.dispatchEvent(new FocusEvent('blur')); // blur commits
    expect(el.value).toBe(100); // clamped
  });

  it('Escape in the edit box reverts (no input)', async () => {
    el = await mount({ value: 3 });
    const onInput = vi.fn();
    el.addEventListener('input', onInput);
    key(el, '9');
    const input = await editInput(el);
    input.value = '999';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.value).toBe(3);
    expect(onInput).not.toHaveBeenCalled();
  });

  it('Backspace resets to defaultValue when set', async () => {
    el = await mount({ value: 88, defaultValue: 60 });
    key(el, 'Backspace');
    expect(el.value).toBe(60);
  });
});
