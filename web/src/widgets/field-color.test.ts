// @vitest-environment happy-dom
/**
 * <field-color> undo coalescing: an OS color-picker drag fires many `input`
 * events; the swatch must funnel them through ONE continuous edit (single undo
 * point), committed on `change`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import './field-color';
import type { FieldColor } from './field-color';
import type { ContinuousEditHandle, FieldBinding } from './field-editor';

function makeBinding(value: number[]) {
  const handle: ContinuousEditHandle = {
    update: vi.fn((v: number[]) => { value = v; }),
    accept: vi.fn(),
    cancel: vi.fn(),
  };
  const binding: FieldBinding = {
    instanceKey: 'k',
    getValue: () => value,
    setValue: vi.fn(),
    beginContinuousEdit: vi.fn(() => handle),
  };
  return { binding, handle };
}

async function mount(binding: FieldBinding, components = 3): Promise<FieldColor> {
  const el = document.createElement('field-color') as FieldColor;
  Object.assign(el, { fieldPath: 'color', components, binding });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function swatch(el: FieldColor): HTMLInputElement {
  return el.renderRoot.querySelector('input[type=color]') as HTMLInputElement;
}

function fire(el: FieldColor, type: string, hex?: string) {
  const input = swatch(el);
  if (hex !== undefined) input.value = hex;
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('<field-color> swatch drag coalescing', () => {
  let el: FieldColor;
  afterEach(() => { el?.remove(); });

  it('creates one continuous edit per drag, committed on change', async () => {
    const { binding, handle } = makeBinding([0, 0, 0]);
    el = await mount(binding);

    fire(el, 'input', '#ff0000');
    fire(el, 'input', '#00ff00');
    fire(el, 'input', '#0000ff');
    expect(binding.beginContinuousEdit).toHaveBeenCalledTimes(1);
    expect(handle.update).toHaveBeenCalledTimes(2);
    expect(binding.setValue).not.toHaveBeenCalled();
    expect(handle.accept).not.toHaveBeenCalled();

    fire(el, 'change');
    expect(handle.accept).toHaveBeenCalledTimes(1);

    // A fresh drag opens a fresh edit.
    fire(el, 'input', '#ffffff');
    expect(binding.beginContinuousEdit).toHaveBeenCalledTimes(2);
  });

  it('commits values through the edit handle with the parsed rgb', async () => {
    const { binding, handle } = makeBinding([0, 0, 0, 0.5]);
    el = await mount(binding, 4);
    fire(el, 'input', '#ff0000');
    expect(binding.beginContinuousEdit).toHaveBeenCalledWith('color', [1, 0, 0, 0.5]);
    fire(el, 'input', '#000080');
    const arg = (handle.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg[0]).toBe(0);
    expect(arg[2]).toBeCloseTo(128 / 255, 5);
    expect(arg[3]).toBe(0.5);
  });

  it('falls back to one-shot setValue when the binding lacks long edits', async () => {
    const value = [0, 0, 0];
    const binding: FieldBinding = {
      instanceKey: 'k',
      getValue: () => value,
      setValue: vi.fn(),
    };
    el = await mount(binding);
    fire(el, 'input', '#ff0000');
    expect(binding.setValue).toHaveBeenCalledTimes(1);
  });

  it('settles a pending swatch edit if the element unmounts mid-drag', async () => {
    const { binding, handle } = makeBinding([0, 0, 0]);
    el = await mount(binding);
    fire(el, 'input', '#ff0000');
    el.remove();
    expect(handle.accept).toHaveBeenCalledTimes(1);
  });
});
